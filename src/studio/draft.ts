import type { Size } from "../config.js";
import type { Manifest, Mode } from "../manifest/schema.js";
import type { TimedWord } from "../media/remotion/caption-pages.js";
import { audioStarts } from "../media/timeline.js";
import { planModes, type PlanModesResult } from "../modes.js";
import { pinnedModes } from "../stages/modes.js";
import { requireScript } from "../stages/require.js";
import { videoProfileOf } from "../video-profiles.js";

/**
 * How long a narration will probably take to speak, before its voiceover exists. 0.055 s per character is the
 * mean over the 22 scenes of the first four live runs (mean error 0.34 s, worst 0.81 s); a draft says "estimate".
 */
export const DRAFT_SEC_PER_CHAR = 0.055;
export const DRAFT_MIN_SCENE_SEC = 1;

export function estimateNarrationSec(narration: string): number {
  return Math.max(DRAFT_MIN_SCENE_SEC, Math.round(narration.trim().length * DRAFT_SEC_PER_CHAR * 100) / 100);
}

/** Estimated length of every scene of a scripted run. */
export function draftDurations(m: Manifest): number[] {
  return requireScript(m).scenes.map((s) => estimateNarrationSec(s.narration));
}

/** The narration's words on the video's clock, each given a share of its scene's estimated length by its letters. */
export function draftWords(m: Manifest): TimedWord[] {
  const durations = draftDurations(m);
  const starts = audioStarts(durations);
  return requireScript(m).scenes.flatMap((scene, i) => {
    const texts = scene.narration.trim().split(/\s+/).filter(Boolean);
    const weights = texts.map((t) => t.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let at = starts[i];
    return texts.map((text, k) => {
      const start = at;
      // the last word ends exactly at the scene's end, so rounding never leaves a gap or an overlap
      at = k === texts.length - 1 ? starts[i] + durations[i] : at + (durations[i] * weights[k]) / total;
      return { text, start, end: at };
    });
  });
}

/**
 * What the mode rules would decide for a draft if every voiceover came out at its estimated length: the same
 * `planModes` the modes stage runs later on the real lengths. Auto runs only.
 */
export function draftEstimate(m: Manifest, keyframeSize: Size, pinned = pinnedModes(m)): PlanModesResult {
  const script = requireScript(m);
  const { modeBudgetUsd: budgetUsd, modePrices: prices } = m.request;
  if (m.request.modes || budgetUsd === undefined || prices === undefined) {
    throw new Error("a draft estimate needs an auto run (this run has explicit modes)");
  }
  const profile = videoProfileOf(m.request.videoProfile);
  const durations = draftDurations(m);
  return planModes({
    scenes: script.scenes.map((s, i) => ({
      actionLevel: s.actionLevel ?? "high",
      shot: s.shot,
      requestedSec: profile.clipSec(durations[i]),
      narrationChars: s.narration.length,
    })),
    prices,
    keyframeSize,
    budgetUsd,
    videoProfile: m.request.videoProfile,
    imageProfile: m.request.imageProfile,
    pinned,
  });
}

/** True while nothing but the script has been bought: the only time a run's modes may still be changed. */
export function isDraft(m: Manifest): boolean {
  if (m.runStages.script?.status !== "done") return false;
  const media = ["tts", "silence", "keyframes", "clips", "fit", "reference"] as const;
  const touched = m.scenes.some((s) => media.some((st) => s.stages[st] !== undefined || s.jobs[st] !== undefined));
  return !touched && !m.ledger.some((e) => e.stage !== "script");
}

/**
 * Pins modes on a draft and writes every scene's provisional mode, so the plan priced before the audio exists
 * matches what the user saw; the modes stage still decides for good once the audio exists.
 */
export function setDraftModes(m: Manifest, overrides: Array<Mode | null>, keyframeSize: Size): PlanModesResult {
  if (!isDraft(m)) throw new Error(`run ${m.runId} is not a draft any more: its modes are frozen with the media bought for them`);
  if (m.request.modes) throw new Error(`run ${m.runId} has explicit modes; only an auto run's scenes can be pinned`);
  if (overrides.length !== m.request.sceneCount) {
    throw new Error(`expected ${m.request.sceneCount} modes (one per scene), got ${overrides.length}`);
  }
  if (overrides.some((o) => o !== null)) m.request.modeOverrides = overrides;
  else delete m.request.modeOverrides;
  const plan = draftEstimate(m, keyframeSize);
  m.scenes.forEach((s, i) => {
    s.mode = plan.modes[i];
  });
  return plan;
}

/** Parses "auto,1,2,auto" (one entry per scene). */
export function parseModeOverrides(raw: string): Array<Mode | null> {
  return raw.split(",").map((part) => {
    const s = part.trim();
    if (s === "auto") return null;
    if (s === "1") return 1;
    if (s === "2") return 2;
    throw new Error(`invalid mode "${s}" (use auto, 1 or 2)`);
  });
}
