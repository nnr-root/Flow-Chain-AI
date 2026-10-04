import { requestedSec } from "../media/timeline.js";
import { planModes, type PlanModesInput } from "../modes.js";
import { requireAudio, requireScript } from "./require.js";
import type { Dep, Stage, StageContext } from "./types.js";

/** The mode rules' inputs; null for explicit runs (--modes / --mode 1|2), whose modes are copied as given. */
function autoInputs(ctx: StageContext): PlanModesInput | null {
  const m = ctx.manifest;
  if (m.request.modes) return null;
  const script = requireScript(m);
  return {
    scenes: m.scenes.map((s, i) => ({
      actionLevel: script.scenes[i].actionLevel ?? "high",
      shot: script.scenes[i].shot,
      requestedSec: requestedSec(requireAudio(s).duration),
      narrationChars: script.scenes[i].narration.length,
    })),
    prices: ctx.prices,
    keyframeSize: ctx.keyframeSize,
    budgetUsd: m.request.modeBudgetUsd ?? 0,
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
    const plan = planModes(auto);
    m.scenes.forEach((s, i) => {
      s.mode = plan.modes[i];
      s.modeReason = plan.reasons[i];
    });
    ctx.log(`modes ${plan.modes.join(",")} (estimated run total $${plan.estimatedUsd.toFixed(2)})`);
  },
};
