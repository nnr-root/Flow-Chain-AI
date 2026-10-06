import { fileSha256 } from "../manifest/hash.js";
import type { Manifest } from "../manifest/schema.js";
import { probeDuration } from "../media/ffmpeg.js";
import { planFit } from "../media/fit.js";
import { extractSeamFrame } from "../media/frames.js";
import { download } from "../providers/download.js";
import { TIMEOUTS } from "../providers/retry.js";
import { videoProfileOf } from "../video-profiles.js";
import { runProviderJob } from "./job.js";
import { effectivePreset } from "./look.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip, requireScript } from "./require.js";
import type { Dep, Stage, StageContext } from "./types.js";
import { autoModeDeps, motionPrompt, needsKeyframe, sceneFrames } from "./visual.js";

/**
 * Writes the seam frame of clip i-1 (the last frame its fitted version shows, spec §4.7) and returns its
 * path. Free and deterministic from clip i-1, frames_{i-1}, size and fps, which is what clip i is keyed on.
 */
async function writeSeam(ctx: StageContext, i: number): Promise<string> {
  const prev = requireClip(ctx.manifest.scenes[i - 1]);
  const frames = sceneFrames(ctx.manifest, ctx.fps)[i - 1];
  const plan = planFit(prev.duration, frames / ctx.fps);
  const seam = await outPath(ctx, paths.seam(i - 1));
  await extractSeamFrame(abs(ctx, prev.path), seam, plan, frames, ctx.size, ctx.fps);
  return seam;
}

/** Clips exist for Mode 1 only; Mode 2 scenes are animated from their keyframe at render time. */
export const isMode1 = (m: Manifest, i: number): boolean => m.scenes[i].mode === 1;

export const clipsStage: Stage = {
  name: "clips",
  perScene: true,
  paid: true,
  appliesTo: isMode1,
  deps: (m, scene) => {
    const i = scene!;
    const deps: Dep[] = [{ stage: "script" }, { stage: "silence", scene: i }, ...autoModeDeps(m)];
    if (needsKeyframe(m, i)) deps.push({ stage: "keyframes", scene: i });
    // A continuing clip starts from clip i-1's seam frame, which depends on frames_{i-1} (durations 0..i-1).
    else deps.push({ stage: "clips", scene: i - 1 });
    // A seam frame is rendered at frames_{i-1}, which depends on every earlier duration.
    if (!needsKeyframe(m, i)) for (let k = 0; k < i; k++) deps.push({ stage: "silence", scene: k });
    return deps;
  },
  async inputsFor(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const script = requireScript(m);
    const base = {
      mode: 1,
      model: m.models.video,
      prompt: motionPrompt(script, i, effectivePreset(m)),
      requestedSec: videoProfileOf(m.request.videoProfile).clipSec(requireAudio(m.scenes[i]).duration),
    };
    if (needsKeyframe(m, i)) return { ...base, imageSha: await fileSha256(abs(ctx, paths.keyframe(i))) };
    // The seam file does not exist yet when this is hashed; key on everything that determines it instead.
    return {
      ...base,
      seam: {
        prevClipSha: await fileSha256(abs(ctx, requireClip(m.scenes[i - 1]).path)),
        prevFrames: sceneFrames(m, ctx.fps)[i - 1],
        size: ctx.size,
        fps: ctx.fps,
      },
    };
  },
  outputsFor: (_m, scene) => [paths.clip(scene!)],
  estimateCostUsd(ctx, scene) {
    const s = ctx.manifest.scenes[scene!];
    const profile = videoProfileOf(ctx.manifest.request.videoProfile);
    // before the audio exists, assume the longest clip the profile buys
    return profile.costUsd(ctx.prices, profile.clipSec(s.audio ? s.audio.duration : Number.POSITIVE_INFINITY));
  },
  async run(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const state = m.scenes[i];
    const script = requireScript(m);
    const out = await outPath(ctx, paths.clip(i));

    const profile = videoProfileOf(m.request.videoProfile);
    const seconds = profile.clipSec(requireAudio(state).duration);
    const result = await runProviderJob(ctx, i, "clips", {
      label: `clip scene ${i + 1}`,
      costUsd: profile.costUsd(ctx.prices, seconds),
      prepare: async () => {
        // the chain image: the scene's own keyframe, or the seam frame of the previous clip
        const imagePath = needsKeyframe(m, i) ? abs(ctx, paths.keyframe(i)) : await writeSeam(ctx, i);
        return ctx.providers.video.prepare({ imagePath, prompt: motionPrompt(script, i, effectivePreset(m)), durationSec: seconds });
      },
      submit: (job, signal) => ctx.providers.video.submit(job, { signal }),
      wait: (id) => ctx.providers.video.wait(id, { timeoutMs: ctx.providers.video.waitMs ?? TIMEOUTS.video }),
      waitMs: ctx.providers.video.waitMs ?? TIMEOUTS.video,
    });
    await download(result.url, out);
    state.clip = { path: paths.clip(i), sourceUrl: result.url, duration: await probeDuration(out), requestedSec: seconds };
  },
};
