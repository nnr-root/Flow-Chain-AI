import type { Prices } from "../config.js";
import { RESTORE_RATES_MISSING, restoreRates, runpodRates } from "../config.js";
import { round4 } from "../cost.js";
import { fileSha256 } from "../manifest/hash.js";
import type { Manifest } from "../manifest/schema.js";
import { probeDuration } from "../media/ffmpeg.js";
import { download } from "../providers/download.js";
import { NonRetryableError, TIMEOUTS } from "../providers/retry.js";
import { videoProfileOf } from "../video-profiles.js";
import { isMode1 } from "./clips.js";
import { INTERPOLATE } from "./interpolate.js";
import { runProviderJob } from "./job.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip } from "./require.js";
import type { Stage } from "./types.js";

/** The short side a full HD clip is made at (phase 8 spec §8). */
export const FULL_HD = 1080;

/**
 * What upscaling `seconds` of clip to full HD costs: the GPU seconds measured for each second of clip, and the
 * worker's start for the first one a run asks for.
 */
export function upscaleCost(p: Prices, seconds: number, first = false, smooth = false): number {
  if (smooth) {
    // the same job also interpolates (phase 11 spec §4): priced at the restorer's own rate, with its extra seconds
    const s = restoreRates(p);
    if (!s) throw new Error(RESTORE_RATES_MISSING);
    return round4((seconds * (runpodRates(p).upscaleSecPerClipSec + s.extraSecPerClipSec) + (first ? s.coldStartSec : 0)) * s.usdPerSec);
  }
  const r = runpodRates(p);
  return round4((seconds * r.upscaleSecPerClipSec + (first ? r.upscaleColdStartSec : 0)) * r.upscaleUsdPerSec);
}

/** Only a moving clip of a run that asked for full HD is upscaled; a still is moved over a picture that is sharp already. */
export const isUpscaled = (m: Manifest, i: number): boolean => m.request.upscale === true && isMode1(m, i);

/**
 * Full HD (phase 8 spec §8): each clip, made at 480p, is upscaled to 1080p by the SeedVR2 worker before it is fitted.
 * Paid, per scene, and keyed on the clip itself: a clip made again is upscaled again, and nothing else is.
 */
export const upscaleStage: Stage = {
  name: "upscale",
  perScene: true,
  paid: true,
  appliesTo: isUpscaled,
  deps: (_m, scene) => [{ stage: "clips", scene }],
  async inputsFor(ctx, scene) {
    return {
      model: ctx.manifest.models.upscale,
      short: FULL_HD,
      clip: await fileSha256(abs(ctx, requireClip(ctx.manifest.scenes[scene!]).path)),
      // only a 60 fps run has it, so every other run keeps the key it had
      ...(ctx.manifest.request.fps === 60 ? { interpolate: INTERPOLATE } : {}),
    };
  },
  outputsFor: (_m, scene) => [paths.upscaled(scene!)],
  estimateCostUsd(ctx, scene) {
    const m = ctx.manifest;
    const s = m.scenes[scene!];
    // before the clip exists, the clip its narration will be bought as; before that, the longest one
    const seconds = s.clip?.duration ?? videoProfileOf(m.request.videoProfile).clipSec(s.audio ? s.audio.duration : Number.POSITIVE_INFINITY);
    const first = m.scenes.findIndex((x) => isUpscaled(m, x.idx)) === scene;
    return upscaleCost(ctx.prices, seconds, first, m.request.fps === 60);
  },
  async run(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const upscale = ctx.providers.upscale;
    if (!upscale) throw new NonRetryableError("this run asked for full HD, and no upscaling endpoint is set for it");
    const clip = requireClip(m.scenes[i]);
    requireAudio(m.scenes[i]);
    const out = await outPath(ctx, paths.upscaled(i));
    const first = m.scenes.findIndex((x) => isUpscaled(m, x.idx)) === i;
    const result = await runProviderJob(ctx, i, "upscale", {
      label: `full HD scene ${i + 1}`,
      costUsd: upscaleCost(ctx.prices, clip.duration, first, m.request.fps === 60),
      prepare: () => upscale.prepare({ videoPath: abs(ctx, clip.path), short: FULL_HD, ...(m.request.fps === 60 ? { interpolate: INTERPOLATE } : {}) }),
      submit: (job, signal) => upscale.submit(job, { signal }),
      wait: (id) => upscale.wait(id, { timeoutMs: upscale.waitMs ?? TIMEOUTS.video }),
      waitMs: upscale.waitMs ?? TIMEOUTS.video,
      submitTimeoutMs: upscale.submitMs,
    });
    await download(result.url, out);
    await result.remove?.();
    m.scenes[i].upscaled = { path: paths.upscaled(i), sourceUrl: result.url, duration: await probeDuration(out) };
  },
};
