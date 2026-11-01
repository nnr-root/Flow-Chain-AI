import type { Manifest, Mode } from "../manifest/schema.js";
import { planModes, type PlanModesInput } from "../modes.js";
import { videoProfileOf } from "../video-profiles.js";
import { speakingClipSec } from "./clips.js";
import { requireAudio, requireScript } from "./require.js";
import type { Dep, Stage, StageContext } from "./types.js";
import { isSpeaking } from "./visual.js";

/** The mode reason of a scene in which a person speaks. */
export const SPEAKING_REASON = "a person speaks in it";

/** The scenes in which a person speaks (phase 15 spec §13.3): they need a clip, so they are always Mode 1. */
const speakingOf = (m: Manifest): number[] => m.scenes.map((s) => s.idx).filter((i) => isSpeaking(m, i));

/**
 * The modes pinned for the rules: the user's (or `user`, a draft's pins being tried), with every speaking scene pinned to
 * Mode 1 over them. Undefined when nothing is pinned, so a run without either keeps its modes cache key.
 */
export function pinnedForRules(m: Manifest, user = pinnedModes(m)): Array<Mode | null> | undefined {
  const speaking = speakingOf(m);
  if (speaking.length === 0) return user;
  return m.scenes.map((_, i) => (speaking.includes(i) ? 1 : (user?.[i] ?? null)));
}

/** The pinned modes, or undefined when nothing is pinned (so runs without overrides keep their modes cache key). */
export function pinnedModes(m: Manifest): Array<Mode | null> | undefined {
  const overrides = m.request.modeOverrides;
  return overrides?.some((o) => o !== null) ? overrides : undefined;
}

/**
 * The scenes as the mode rules see them, for the modes stage (on the real voiceovers) and the draft (on their estimated
 * lengths, `voiceSec`) alike: the draft's approved price must plan what the stage decides, or a speaking scene the draft
 * priced as a voiced still is forced into a clip later and the run stops at its media checkpoint over the cap, after its
 * voiceover was bought. `voiceSec` is read only for a scene that does not speak.
 */
export function ruleScenes(m: Manifest, voiceSec: (i: number) => number): PlanModesInput["scenes"] {
  const profile = videoProfileOf(m.request.videoProfile);
  return requireScript(m).scenes.map((s, i) => ({
    actionLevel: s.actionLevel ?? "high",
    shot: s.shot,
    // (a speaking scene has no length before its clip, which comes after this stage: it is priced at the clip it buys)
    requestedSec: isSpeaking(m, i) ? speakingClipSec(m, i) : profile.clipSec(voiceSec(i)),
    // (no voiceover is bought for a speaking scene: its voice is in its clip)
    narrationChars: isSpeaking(m, i) ? 0 : s.narration.length,
  }));
}

/** The mode rules' inputs; null for explicit runs (--modes / --mode 1|2), whose modes are copied as given. */
function autoInputs(ctx: StageContext): PlanModesInput | null {
  const m = ctx.manifest;
  if (m.request.modes) return null;
  const { modeBudgetUsd: budgetUsd, modePrices: prices } = m.request;
  if (budgetUsd === undefined || prices === undefined) {
    throw new Error("auto modes need the budget and price table frozen at creation");
  }
  return {
    scenes: ruleScenes(m, (i) => requireAudio(m.scenes[i]).duration),
    prices,
    keyframeSize: ctx.keyframeSize,
    budgetUsd,
    videoProfile: m.request.videoProfile,
    imageProfile: m.request.imageProfile,
    pinned: pinnedForRules(m),
  };
}

/** A speaking scene is Mode 1 whatever was asked (phase 15 spec §13.3): its sound and its length are its clip's. */
function keepSpeakersMoving(m: Manifest): void {
  for (const i of speakingOf(m)) {
    m.scenes[i].mode = 1;
    m.scenes[i].modeReason = SPEAKING_REASON;
  }
}

/**
 * Resolves every scene's mode (spec §4.1). Runs after silence, so each clip length (from the run's video profile)
 * is exact, and before keyframes, so the media checkpoint prices the final modes. Free and cached.
 */
export const modesStage: Stage = {
  name: "modes",
  perScene: false,
  paid: false,
  // (a speaking scene's length is not read here: its clip, which makes it, is bought after the modes are decided)
  deps: (m) => [{ stage: "script" }, ...m.scenes.filter((s) => !isSpeaking(m, s.idx)).map((s): Dep => ({ stage: "silence", scene: s.idx }))],
  inputsFor: async (ctx) => {
    const auto = autoInputs(ctx);
    if (auto) return { auto };
    const speaking = speakingOf(ctx.manifest);
    return { explicit: ctx.manifest.request.modes, ...(speaking.length ? { speaking } : {}) };
  },
  outputsFor: () => [],
  estimateCostUsd: () => 0,
  async run(ctx) {
    const m = ctx.manifest;
    const auto = autoInputs(ctx);
    if (!auto) {
      m.scenes.forEach((s, i) => {
        s.mode = m.request.modes![i];
        s.modeReason = "explicit";
      });
      keepSpeakersMoving(m);
      return;
    }
    const noLevel = requireScript(m).scenes.filter((s) => s.actionLevel === undefined).length;
    if (noLevel > 0) ctx.log(`modes: ${noLevel} scene(s) have no actionLevel; treated as high`);
    // Once a keyframe or clip is paid for, re-planning (e.g. after a TTS reroll moved a clip to another 5/10 s
    // bucket) could switch a scene to Mode 2 and throw that media away to "save" money already spent: keep the modes.
    const bought = m.ledger.some((e) => e.stage === "keyframes" || e.stage === "clips");
    if (bought && m.scenes.every((s) => s.modeReason !== undefined)) {
      keepSpeakersMoving(m);
      ctx.log(`modes kept at ${m.scenes.map((s) => s.mode).join(",")}: media was already bought for them`);
      return;
    }
    const plan = planModes(auto);
    m.scenes.forEach((s, i) => {
      s.mode = plan.modes[i];
      s.modeReason = plan.reasons[i];
    });
    keepSpeakersMoving(m);
    ctx.log(`modes ${plan.modes.join(",")} (estimated run total $${plan.estimatedUsd.toFixed(2)})`);
  },
};
