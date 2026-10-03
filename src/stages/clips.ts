import { videoCost } from "../cost.js";
import { fileSha256 } from "../manifest/hash.js";
import { probeDuration } from "../media/ffmpeg.js";
import { extractLastFrame } from "../media/frames.js";
import { renderKenBurns } from "../media/kenburns.js";
import { requestedSec } from "../media/timeline.js";
import { download } from "../providers/download.js";
import { TIMEOUTS } from "../providers/retry.js";
import { runProviderJob } from "./job.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireScript } from "./require.js";
import type { Dep, Stage } from "./types.js";
import { chainImagePath, motionPrompt, needsKeyframe, sceneFrames } from "./visual.js";

export const clipsStage: Stage = {
  name: "clips",
  perScene: true,
  paid: true,
  deps: (m, scene) => {
    const i = scene!;
    const deps: Dep[] = [{ stage: "script" }, { stage: "silence", scene: i }];
    deps.push(needsKeyframe(m, i) ? { stage: "keyframes", scene: i } : { stage: "clips", scene: i - 1 });
    // A Mode 2 clip is rendered at frames_i, which depends on every earlier scene's duration.
    if (m.scenes[i].mode === 2) for (let k = 0; k < i; k++) deps.push({ stage: "silence", scene: k });
    return deps;
  },
  async inputsFor(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const script = requireScript(m);
    const imageSha = await fileSha256(abs(ctx, chainImagePath(m, i)));
    if (m.scenes[i].mode === 1) {
      return {
        mode: 1,
        model: m.models.video,
        prompt: motionPrompt(script, i),
        requestedSec: requestedSec(requireAudio(m.scenes[i]).duration),
        imageSha,
      };
    }
    return {
      mode: 2,
      camera: script.scenes[i].camera,
      frames: sceneFrames(m, ctx.fps)[i],
      size: ctx.size,
      fps: ctx.fps,
      imageSha,
    };
  },
  outputsFor: (m, scene) =>
    m.scenes[scene!].mode === 1 ? [paths.clip(scene!), paths.lastFrame(scene!)] : [paths.clip(scene!)],
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
    const chainImage = abs(ctx, chainImagePath(m, i));

    if (state.mode === 2) {
      const frames = sceneFrames(m, ctx.fps)[i];
      await renderKenBurns(chainImage, out, script.scenes[i].camera, frames, ctx.size, ctx.fps);
      state.clip = { path: paths.clip(i), duration: frames / ctx.fps };
      state.lastFrame = undefined;
      return;
    }

    const seconds = requestedSec(requireAudio(state).duration);
    const result = await runProviderJob(ctx, i, "clips", {
      label: `clip scene ${i + 1}`,
      costUsd: videoCost(ctx.prices, seconds),
      submit: () =>
        ctx.providers.video.submit({ imagePath: chainImage, prompt: motionPrompt(script, i), durationSec: seconds }),
      wait: (id) => ctx.providers.video.wait(id, { timeoutMs: TIMEOUTS.video }),
      waitMs: TIMEOUTS.video,
    });
    await download(result.url, out);
    const last = await outPath(ctx, paths.lastFrame(i));
    await extractLastFrame(out, last);
    state.clip = { path: paths.clip(i), sourceUrl: result.url, duration: await probeDuration(out), requestedSec: seconds };
    state.lastFrame = { path: paths.lastFrame(i), sha256: await fileSha256(last) };
  },
};
