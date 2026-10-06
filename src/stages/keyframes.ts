import { imageProfileOf } from "../image-profiles.js";
import { download } from "../providers/download.js";
import { TIMEOUTS } from "../providers/retry.js";
import { runProviderJob } from "./job.js";
import { effectivePreset } from "./look.js";
import { abs, outPath, paths } from "./paths.js";
import { referenceImageOf } from "./reference.js";
import { fileSha256 } from "../manifest/hash.js";
import { requireScript } from "./require.js";
import { MAX_SEED, type Manifest } from "../manifest/schema.js";
import type { Stage } from "./types.js";
import { autoModeDeps, imagePrompt, needsKeyframe } from "./visual.js";

/**
 * The Flux seed for scene i: the run's shared seed plus that scene's keyframe reroll count, so scenes share a
 * seed and a reroll still gets a new image. Undefined for runs without a seed (made before 2.3).
 */
export function keyframeSeed(m: Manifest, i: number): number | undefined {
  const seed = m.request.seed;
  if (seed === undefined) return undefined;
  return (seed + (m.scenes[i].nonces.keyframes ?? 0)) % (MAX_SEED + 1);
}

export const keyframesStage: Stage = {
  name: "keyframes",
  perScene: true,
  paid: true,
  appliesTo: needsKeyframe,
  deps: (m) => [
    { stage: "script" },
    ...autoModeDeps(m),
    // RunPod runs condition every keyframe on the reference portrait (2.4 spec §5.2)
    ...(m.request.imageProfile === "runpod-sdxl@1" ? [{ stage: "reference" as const, scene: 0 }] : []),
  ],
  inputsFor: async (ctx, scene) => {
    const reference = referenceImageOf(ctx.manifest);
    return {
      model: ctx.manifest.models.image,
      prompt: imagePrompt(requireScript(ctx.manifest), scene!, effectivePreset(ctx.manifest)),
      size: ctx.keyframeSize,
      seed: keyframeSeed(ctx.manifest, scene!),
      // only runs with a reference key on it, so every other run keeps its cache key
      reference: reference === undefined ? undefined : await fileSha256(abs(ctx, reference)),
    };
  },
  outputsFor: (_m, scene) => [paths.keyframe(scene!)],
  estimateCostUsd(ctx, scene) {
    const profile = imageProfileOf(ctx.manifest.request.imageProfile);
    // the run's first keyframe also pays the endpoint's cold start (0 on fal)
    const first = ctx.manifest.scenes.findIndex((s) => needsKeyframe(ctx.manifest, s.idx)) === scene;
    return profile.keyframeUsd(ctx.prices, ctx.keyframeSize) + (first ? profile.runOverheadUsd(ctx.prices) : 0);
  },
  async run(ctx, scene) {
    const i = scene!;
    const prompt = imagePrompt(requireScript(ctx.manifest), i, effectivePreset(ctx.manifest));
    const result = await runProviderJob(ctx, i, "keyframes", {
      label: `keyframe scene ${i + 1}`,
      costUsd: imageProfileOf(ctx.manifest.request.imageProfile).keyframeUsd(ctx.prices, ctx.keyframeSize),
      prepare: () => {
        const reference = referenceImageOf(ctx.manifest);
        return ctx.providers.image.prepare({
          prompt,
          ...ctx.keyframeSize,
          seed: keyframeSeed(ctx.manifest, i),
          preset: effectivePreset(ctx.manifest)?.name,
          referenceImagePath: reference === undefined ? undefined : abs(ctx, reference),
        });
      },
      submit: (job, signal) => ctx.providers.image.submit(job, { signal }),
      wait: (id) => ctx.providers.image.wait(id, { timeoutMs: ctx.providers.image.waitMs ?? TIMEOUTS.image }),
      waitMs: ctx.providers.image.waitMs ?? TIMEOUTS.image,
    });
    await download(result.url, await outPath(ctx, paths.keyframe(i)));
    ctx.manifest.scenes[i].keyframe = { path: paths.keyframe(i), seed: result.seed, sourceUrl: result.url };
  },
};
