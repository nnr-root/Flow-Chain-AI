import { videoCost } from "../cost.js";
import { fileSha256 } from "../manifest/hash.js";
import { probeDuration } from "../media/ffmpeg.js";
import { planFit } from "../media/fit.js";
import { extractSeamFrame } from "../media/frames.js";
import { renderKenBurns } from "../media/kenburns.js";
import { requestedSec } from "../media/timeline.js";
import { download } from "../providers/download.js";
import { TIMEOUTS } from "../providers/retry.js";
import { runProviderJob } from "./job.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip, requireScript } from "./require.js";
import type { Dep, Stage, StageContext } from "./types.js";
import { motionPrompt, needsKeyframe, sceneFrames } from "./visual.js";

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

export const clipsStage: Stage = {
  name: "clips",
  perScene: true,
  paid: true,
  deps: (m, scene) => {
    const i = scene!;
    const deps: Dep[] = [{ stage: "script" }, { stage: "silence", scene: i }];
    if (needsKeyframe(m, i)) deps.push({ stage: "keyframes", scene: i });
    // A continuing clip starts from clip i-1's seam frame, which depends on frames_{i-1} (durations 0..i-1).
    else deps.push({ stage: "clips", scene: i - 1 });
    // A Mode 2 clip is rendered at frames_i, and a seam frame at frames_{i-1}: both depend on earlier durations.
    if (m.scenes[i].mode === 2 || !needsKeyframe(m, i)) {
      for (let k = 0; k < i; k++) deps.push({ stage: "silence", scene: k });
    }
    return deps;
  },
  async inputsFor(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const script = requireScript(m);
    if (m.scenes[i].mode === 2) {
      return {
        mode: 2,
        camera: script.scenes[i].camera,
        frames: sceneFrames(m, ctx.fps)[i],
        size: ctx.size,
        fps: ctx.fps,
        imageSha: await fileSha256(abs(ctx, paths.keyframe(i))),
      };
    }
    const base = {
      mode: 1,
      model: m.models.video,
      prompt: motionPrompt(script, i),
      requestedSec: requestedSec(requireAudio(m.scenes[i]).duration),
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
    if (s.mode === 2) return 0;
    return videoCost(ctx.prices, s.audio ? requestedSec(s.audio.duration) : 10);
  },
  async run(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const state = m.scenes[i];
    const script = requireScript(m);
    const out = await outPath(ctx, paths.clip(i));

    if (state.mode === 2) {
      const frames = sceneFrames(m, ctx.fps)[i];
      await renderKenBurns(abs(ctx, paths.keyframe(i)), out, script.scenes[i].camera, frames, ctx.size, ctx.fps);
      state.clip = { path: paths.clip(i), duration: frames / ctx.fps };
      return;
    }

    const seconds = requestedSec(requireAudio(state).duration);
    const result = await runProviderJob(ctx, i, "clips", {
      label: `clip scene ${i + 1}`,
      costUsd: videoCost(ctx.prices, seconds),
      submit: async () => {
        // the chain image: the scene's own keyframe, or the seam frame of the previous clip
        const imagePath = needsKeyframe(m, i) ? abs(ctx, paths.keyframe(i)) : await writeSeam(ctx, i);
        return ctx.providers.video.submit({ imagePath, prompt: motionPrompt(script, i), durationSec: seconds });
      },
      wait: (id) => ctx.providers.video.wait(id, { timeoutMs: TIMEOUTS.video }),
      waitMs: TIMEOUTS.video,
    });
    await download(result.url, out);
    state.clip = { path: paths.clip(i), sourceUrl: result.url, duration: await probeDuration(out), requestedSec: seconds };
  },
};
