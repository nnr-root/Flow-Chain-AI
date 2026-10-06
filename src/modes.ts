import type { Prices, Size } from "./config.js";
import { round4, scriptCost, ttsCost } from "./cost.js";
import { type ImageProfileId, imageProfileOf } from "./image-profiles.js";
import type { ActionLevel, Mode, Shot } from "./manifest/schema.js";
import { type VideoProfileId, videoProfileOf } from "./video-profiles.js";

export type PlanModesInput = {
  scenes: Array<{ actionLevel: ActionLevel; shot: Shot; requestedSec: number; narrationChars: number }>;
  videoProfile?: VideoProfileId;
  /** Prices the keyframes; absent = fal-flux@1 (so runs made before 2.4 keep their modes cache key). */
  imageProfile?: ImageProfileId;
  prices: Prices;
  keyframeSize: Size;
  budgetUsd: number;
};
export type PlanModesResult = { modes: Mode[]; reasons: string[]; estimatedUsd: number };

const START: Record<ActionLevel, Mode> = { high: 1, medium: 1, low: 2 };

/** The whole run's cost under candidate modes (spec §5): keyframes follow the Phase 1 rule on these modes. */
function runCost(input: PlanModesInput, modes: Mode[]): number {
  const { scenes, prices } = input;
  const image = imageProfileOf(input.imageProfile);
  const video = videoProfileOf(input.videoProfile);
  // a cold start is paid once per run by each endpoint that is used (0 for fal and Kling)
  let usd = scriptCost(prices) + image.runOverheadUsd(prices);
  scenes.forEach((s, i) => {
    usd += ttsCost(prices, s.narrationChars);
    if (i === 0 || modes[i] === 2 || modes[i - 1] === 2 || s.shot === "cut") usd += image.keyframeUsd(prices, input.keyframeSize);
    if (modes[i] === 1) usd += video.costUsd(prices, s.requestedSec);
  });
  if (modes.includes(1)) usd += video.runOverheadUsd(prices);
  return round4(usd);
}

/**
 * Smart Hybrid Mode Recommender (spec §5): high → Mode 1, low → Mode 2, medium → Mode 1 while the budget
 * allows. Over budget, medium scenes drop to Mode 2 one at a time, largest saving first (ties: the later
 * scene). High scenes are never downgraded.
 */
export function planModes(input: PlanModesInput): PlanModesResult {
  const modes = input.scenes.map((s) => START[s.actionLevel]);
  const downgraded = new Set<number>();
  let cost = runCost(input, modes);
  while (cost > input.budgetUsd) {
    let best: { i: number; saving: number } | undefined;
    input.scenes.forEach((s, i) => {
      if (s.actionLevel !== "medium" || modes[i] !== 1) return;
      const saving = round4(cost - runCost(input, modes.with(i, 2)));
      if (!best || saving >= best.saving) best = { i, saving };
    });
    if (!best || best.saving <= 0) break; // nothing left that makes the run cheaper
    modes[best.i] = 2;
    downgraded.add(best.i);
    cost = runCost(input, modes);
  }
  const reasons = input.scenes.map((s, i) =>
    downgraded.has(i)
      ? `auto: medium action → Mode 2 to fit $${input.budgetUsd.toFixed(2)}`
      : `auto: ${s.actionLevel} action`,
  );
  return { modes, reasons, estimatedUsd: cost };
}
