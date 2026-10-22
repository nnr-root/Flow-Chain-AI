import type { Prices } from "../config.js";
import { RESTORE_RATES_MISSING, restoreRates } from "../config.js";
import { round4 } from "../cost.js";
import { fileSha256 } from "../manifest/hash.js";
import type { Manifest } from "../manifest/schema.js";
import { probeDuration } from "../media/ffmpeg.js";
import { download } from "../providers/download.js";
import { NonRetryableError, TIMEOUTS } from "../providers/retry.js";
import { videoProfileOf } from "../video-profiles.js";
import { isMode1 } from "./clips.js";
import { runProviderJob } from "./job.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip } from "./require.js";
import type { Stage } from "./types.js";

/** The frame-rate multiplier a clip is interpolated by: 16 fps Wan, 32 after the clip worker's RIFE, 64 after this (phase 11 spec §0). */
export const INTERPOLATE = 2;

/** What interpolating `seconds` of clip costs: the GPU seconds measured for each second of clip, and the worker's start for the first one. */
export function interpolateCost(p: Prices, seconds: number, first = false): number {
  const r = restoreRates(p);
  if (!r) throw new Error(RESTORE_RATES_MISSING);
  return round4((seconds * r.interpolateSecPerClipSec + (first ? r.coldStartSec : 0)) * r.usdPerSec);
}

/** Only a moving clip of a 60 fps run that is not in full HD is interpolated on its own (in full HD the upscale job does it). */
export const isSmoothed = (m: Manifest, i: number): boolean => m.request.fps === 60 && m.request.upscale !== true && isMode1(m, i);

export const interpolateStage: Stage = {
  name: "interpolate",
  perScene: true,
  paid: true,
  appliesTo: isSmoothed,
  deps: (_m, scene) => [{ stage: "clips", scene }],
  async inputsFor(ctx, scene) {
    return { model: ctx.manifest.models.upscale, interpolate: INTERPOLATE, clip: await fileSha256(abs(ctx, requireClip(ctx.manifest.scenes[scene!]).path)) };
  },
  outputsFor: (_m, scene) => [paths.smoothed(scene!)],
  estimateCostUsd(ctx, scene) {
    const m = ctx.manifest;
    const s = m.scenes[scene!];
    const seconds = s.clip?.duration ?? videoProfileOf(m.request.videoProfile).clipSec(s.audio ? s.audio.duration : Number.POSITIVE_INFINITY);
    const first = m.scenes.findIndex((x) => isSmoothed(m, x.idx)) === scene;
    return interpolateCost(ctx.prices, seconds, first);
  },
  async run(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const restore = ctx.providers.upscale;
    if (!restore) throw new NonRetryableError("this run asked for smooth motion, and no restorer endpoint is set for it");
    const clip = requireClip(m.scenes[i]);
    requireAudio(m.scenes[i]);
    const out = await outPath(ctx, paths.smoothed(i));
    const first = m.scenes.findIndex((x) => isSmoothed(m, x.idx)) === i;
    const result = await runProviderJob(ctx, i, "interpolate", {
      label: `smooth motion scene ${i + 1}`,
      costUsd: interpolateCost(ctx.prices, clip.duration, first),
      prepare: () => restore.prepare({ videoPath: abs(ctx, clip.path), interpolate: INTERPOLATE }),
      submit: (job, signal) => restore.submit(job, { signal }),
      wait: (id) => restore.wait(id, { timeoutMs: restore.waitMs ?? TIMEOUTS.video }),
      waitMs: restore.waitMs ?? TIMEOUTS.video,
      submitTimeoutMs: restore.submitMs,
    });
    await download(result.url, out);
    await result.remove?.();
    m.scenes[i].smoothed = { path: paths.smoothed(i), sourceUrl: result.url, duration: await probeDuration(out) };
  },
};
