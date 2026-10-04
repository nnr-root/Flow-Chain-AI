import { fileSha256 } from "../manifest/hash.js";
import { applyFit, planFit } from "../media/fit.js";
import { abs, outPath, paths } from "./paths.js";
import { isMode1 } from "./clips.js";
import { requireClip } from "./require.js";
import type { Stage } from "./types.js";
import { sceneFrames } from "./visual.js";

export const fitStage: Stage = {
  name: "fit",
  perScene: true,
  paid: false,
  appliesTo: isMode1,
  // frames_i depends on the durations of every scene up to and including i
  deps: (m, scene) => [
    { stage: "clips", scene },
    ...m.scenes.slice(0, scene! + 1).map((s) => ({ stage: "silence" as const, scene: s.idx })),
  ],
  inputsFor: async (ctx, scene) => ({
    clip: await fileSha256(abs(ctx, paths.clip(scene!))),
    frames: sceneFrames(ctx.manifest, ctx.fps)[scene!],
    size: ctx.size,
    fps: ctx.fps,
  }),
  outputsFor: (_m, scene) => [paths.fitted(scene!)],
  estimateCostUsd: () => 0,
  async run(ctx, scene) {
    const i = scene!;
    const state = ctx.manifest.scenes[i];
    const clip = requireClip(state);
    const frames = sceneFrames(ctx.manifest, ctx.fps)[i];
    const plan = planFit(clip.duration, frames / ctx.fps);
    await applyFit(abs(ctx, clip.path), await outPath(ctx, paths.fitted(i)), plan, frames, ctx.size, ctx.fps);
    state.fitted = { path: paths.fitted(i), frames, plan };
    if (plan.kind !== "trim") ctx.log(`scene ${i + 1}: clip shorter than its audio, fit plan ${JSON.stringify(plan)}`);
  },
};
