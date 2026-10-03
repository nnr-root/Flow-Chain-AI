import { imageCost } from "../cost.js";
import { download } from "../providers/download.js";
import { TIMEOUTS } from "../providers/retry.js";
import { runProviderJob } from "./job.js";
import { outPath, paths } from "./paths.js";
import { requireScript } from "./require.js";
import type { Stage } from "./types.js";
import { imagePrompt, needsKeyframe } from "./visual.js";

export const keyframesStage: Stage = {
  name: "keyframes",
  perScene: true,
  paid: true,
  appliesTo: needsKeyframe,
  deps: () => [{ stage: "script" }],
  inputsFor: async (ctx, scene) => ({
    model: ctx.manifest.models.image,
    prompt: imagePrompt(requireScript(ctx.manifest), scene!),
    size: ctx.keyframeSize,
  }),
  outputsFor: (_m, scene) => [paths.keyframe(scene!)],
  estimateCostUsd: (ctx) => imageCost(ctx.prices, ctx.keyframeSize),
  async run(ctx, scene) {
    const i = scene!;
    const prompt = imagePrompt(requireScript(ctx.manifest), i);
    const result = await runProviderJob(ctx, i, "keyframes", {
      label: `keyframe scene ${i + 1}`,
      costUsd: imageCost(ctx.prices, ctx.keyframeSize),
      submit: () => ctx.providers.image.submit({ prompt, ...ctx.keyframeSize }),
      wait: (id) => ctx.providers.image.wait(id, { timeoutMs: TIMEOUTS.image }),
      waitMs: TIMEOUTS.image,
    });
    await download(result.url, await outPath(ctx, paths.keyframe(i)));
    ctx.manifest.scenes[i].keyframe = { path: paths.keyframe(i), seed: result.seed, sourceUrl: result.url };
  },
};
