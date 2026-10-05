import { requestedSec } from "../media/timeline.js";
import { planModes, type PlanModesInput } from "../modes.js";
import { requireAudio, requireScript } from "./require.js";
import type { Dep, Stage, StageContext } from "./types.js";

/** The mode rules' inputs; null for explicit runs (--modes / --mode 1|2), whose modes are copied as given. */
function autoInputs(ctx: StageContext): PlanModesInput | null {
  const m = ctx.manifest;
  if (m.request.modes) return null;
  const script = requireScript(m);
  const { modeBudgetUsd: budgetUsd, modePrices: prices } = m.request;
  if (budgetUsd === undefined || prices === undefined) {
    throw new Error("auto modes need the budget and price table frozen at creation");
  }
  return {
    scenes: m.scenes.map((s, i) => ({
      actionLevel: script.scenes[i].actionLevel ?? "high",
      shot: script.scenes[i].shot,
      requestedSec: requestedSec(requireAudio(s).duration),
      narrationChars: script.scenes[i].narration.length,
    })),
    prices,
    keyframeSize: ctx.keyframeSize,
    budgetUsd,
  };
}

/**
 * Resolves every scene's mode (spec §4.1). Runs after silence, so each Kling bucket (5 s / 10 s) is exact,
 * and before keyframes, so the media checkpoint prices the final modes. Free and cached.
 */
export const modesStage: Stage = {
  name: "modes",
  perScene: false,
  paid: false,
  deps: (m) => [{ stage: "script" }, ...m.scenes.map((s): Dep => ({ stage: "silence", scene: s.idx }))],
  inputsFor: async (ctx) => {
    const auto = autoInputs(ctx);
    return auto ? { auto } : { explicit: ctx.manifest.request.modes };
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
      return;
    }
    const noLevel = requireScript(m).scenes.filter((s) => s.actionLevel === undefined).length;
    if (noLevel > 0) ctx.log(`modes: ${noLevel} scene(s) have no actionLevel; treated as high`);
    // Once a keyframe or clip is paid for, re-planning (e.g. after a TTS reroll moved a clip to another 5/10 s
    // bucket) could switch a scene to Mode 2 and throw that media away to "save" money already spent: keep the modes.
    const bought = m.ledger.some((e) => e.stage === "keyframes" || e.stage === "clips");
    if (bought && m.scenes.every((s) => s.modeReason !== undefined)) {
      ctx.log(`modes kept at ${m.scenes.map((s) => s.mode).join(",")}: media was already bought for them`);
      return;
    }
    const plan = planModes(auto);
    m.scenes.forEach((s, i) => {
      s.mode = plan.modes[i];
      s.modeReason = plan.reasons[i];
    });
    ctx.log(`modes ${plan.modes.join(",")} (estimated run total $${plan.estimatedUsd.toFixed(2)})`);
  },
};
