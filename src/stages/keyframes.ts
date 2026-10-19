import { editById } from "../edits.js";
import { imageProfileOf, takesReference, takesSeveralReferences } from "../image-profiles.js";
import { download } from "../providers/download.js";
import { TIMEOUTS } from "../providers/retry.js";
import { runProviderJob } from "./job.js";
import { effectivePreset } from "./look.js";
import { abs, outPath, paths } from "./paths.js";
import { referenceFor, referenceImageOf } from "./reference.js";
import { referenceNoteFor, referencesFor, referenceScenes } from "./references.js";
import { warmClipsEarly } from "./warmup.js";
import { inspect, MAX_REMAKES, noteRemake, remakeOf } from "./inspect.js";
import { fileSha256 } from "../manifest/hash.js";
import { requireScript } from "./require.js";
import { MAX_SEED, type Manifest } from "../manifest/schema.js";
import type { Stage } from "./types.js";
import { autoModeDeps, expectedOf, imagePrompt, needsKeyframe } from "./visual.js";

/**
 * The Flux seed for scene i: the run's shared seed plus that scene's keyframe reroll count, so scenes share a
 * seed and a reroll still gets a new image. Undefined for runs without a seed (made before 2.3).
 */
export function keyframeSeed(m: Manifest, i: number): number | undefined {
  const seed = m.request.seed;
  if (seed === undefined) return undefined;
  return (seed + (m.scenes[i].nonces.keyframes ?? 0)) % (MAX_SEED + 1);
}

const withNote = (prompt: string, note: string): string => (note ? `${prompt} ${note}` : prompt);

export const keyframesStage: Stage = {
  name: "keyframes",
  perScene: true,
  paid: true,
  appliesTo: needsKeyframe,
  deps: (m, scene) => [
    { stage: "script" },
    ...autoModeDeps(m),
    // RunPod runs condition keyframes on the reference portrait (2.4 spec §5.2)
    ...(takesReference(m.request.imageProfile) ? [{ stage: "reference" as const, scene: 0 }] : []),
    // a FLUX 3 keyframe is conditioned on other keyframes: it waits for them
    ...(scene === undefined ? [] : referenceScenes(m, scene).map((s) => ({ stage: "keyframes" as const, scene: s }))),
  ],
  inputsFor: async (ctx, scene) => {
    const reference = referenceFor(ctx.manifest, scene!);
    const several = takesSeveralReferences(ctx.manifest.request.imageProfile);
    const refs = several ? referencesFor(ctx.manifest, scene!) : [];
    return {
      model: ctx.manifest.models.image,
      prompt: withNote(imagePrompt(requireScript(ctx.manifest), scene!, effectivePreset(ctx.manifest), editById(ctx.manifest.request.edit)), referenceNoteFor(ctx.manifest, scene!)),
      size: ctx.keyframeSize,
      seed: keyframeSeed(ctx.manifest, scene!),
      // only runs with a reference key on it, so every other run keeps its cache key
      reference: !several && reference !== undefined ? await fileSha256(abs(ctx, reference)) : undefined,
      references: refs.length ? await Promise.all(refs.map((p) => fileSha256(abs(ctx, p)))) : undefined,
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
    const prompt = withNote(imagePrompt(requireScript(ctx.manifest), i, effectivePreset(ctx.manifest), editById(ctx.manifest.request.edit)), referenceNoteFor(ctx.manifest, i));
    const m = ctx.manifest;
    const left = m.scenes.filter((s) => s.idx >= i && needsKeyframe(m, s.idx)).length;
    const first = m.scenes.findIndex((s) => needsKeyframe(m, s.idx)) === i && referenceImageOf(m) !== paths.reference;
    await warmClipsEarly(ctx, left, first);
    // each picture is looked at before a clip is made from it, and made again with another seed when it is
    // malformed (phase 8 spec §9); a remake is its own job, so a stopped run carries on from it
    for (let remake = remakeOf(ctx, i, "keyframes"); ; remake++) {
      const base = keyframeSeed(ctx.manifest, i);
      const seed = remake === 0 || base === undefined ? base : (base + remake * 104_729) % (MAX_SEED + 1);
      const result = await runProviderJob({ ...ctx, inputHash: remake === 0 ? ctx.inputHash : `${ctx.inputHash}#${remake}` }, i, "keyframes", {
        label: `keyframe scene ${i + 1}${remake ? ` (made again, ${remake})` : ""}`,
        costUsd: imageProfileOf(ctx.manifest.request.imageProfile).keyframeUsd(ctx.prices, ctx.keyframeSize),
        prepare: () => {
          const several = takesSeveralReferences(ctx.manifest.request.imageProfile);
          const reference = referenceFor(ctx.manifest, i);
          const refs = several ? referencesFor(ctx.manifest, i).map((p) => abs(ctx, p)) : [];
          return ctx.providers.image.prepare({
            prompt,
            ...ctx.keyframeSize,
            seed: remake === 0 ? keyframeSeed(ctx.manifest, i) : seed,
            preset: effectivePreset(ctx.manifest)?.name,
            referenceImagePath: !several && reference !== undefined ? abs(ctx, reference) : undefined,
            referenceImagePaths: refs.length ? refs : undefined,
          });
        },
        submit: (job, signal) => ctx.providers.image.submit(job, { signal }),
        wait: (id) => ctx.providers.image.wait(id, { timeoutMs: ctx.providers.image.waitMs ?? TIMEOUTS.image }),
        waitMs: ctx.providers.image.waitMs ?? TIMEOUTS.image,
        submitTimeoutMs: ctx.providers.image.submitMs,
      });
      const file = await outPath(ctx, paths.keyframe(i));
      await download(result.url, file);
      // the run has its own copy now: the one the worker uploaded is taken out of the bucket
      await result.remove?.();
      ctx.manifest.scenes[i].keyframe = { path: paths.keyframe(i), seed: result.seed, sourceUrl: result.url };
      if (remake >= (MAX_REMAKES.keyframes ?? 0)) break;
      const verdict = await inspect(ctx, [file], expectedOf(requireScript(m), i));
      if (verdict.ok) break;
      ctx.log(`keyframe scene ${i + 1} is malformed (${verdict.problems.join("; ")}): making it again`);
      await noteRemake(ctx, i, "keyframes", remake + 1);
    }
  },
};
