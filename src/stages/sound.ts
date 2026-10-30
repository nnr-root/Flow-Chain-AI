import { rm, stat } from "node:fs/promises";
import { fileSha256 } from "../manifest/hash.js";
import type { Manifest } from "../manifest/schema.js";
import { ffmpeg, probeVideo } from "../media/ffmpeg.js";
import { levelSound } from "../media/loudness.js";
import { movingInputArgs, soundInputSize, stillInputArgs } from "../media/sound-input.js";
import { download } from "../providers/download.js";
import { NonRetryableError, TIMEOUTS } from "../providers/retry.js";
import { MAX_INPUT_BYTES } from "../providers/runpod-providers.js";
import { guidanceFor, SCENE_SOUND_MAX_SEC, SOUND_NEGATIVE_PROMPT, SOUND_STEPS, soundAskSeconds, soundCost, soundSeed } from "../sound.js";
import { runProviderJob } from "./job.js";
import { abs, outPath, paths } from "./paths.js";
import { requireFitted, requireKeyframe } from "./require.js";
import type { Stage, StageContext } from "./types.js";
import { sceneFrames } from "./visual.js";

/**
 * Whether scene i has a sound of its own made (phase 14 spec §3): only in a run made with scene sound and with sound
 * effects on, and only where the script wrote what is heard there. Before the script is written every scene is
 * counted, so the first plan prices the sound a run will buy.
 */
export const hasSceneSound = (m: Manifest, i: number): boolean =>
  m.request.sceneSound === true && m.request.render.sfx && (m.script ? Boolean(m.script.scenes[i]?.soundPrompt) : true);

const isStill = (m: Manifest, i: number) => m.scenes[i].mode === 2;

/** Scene i's length in the video, in seconds: its frames (what the fit made it, or what a still is shown for). */
const sceneSeconds = (ctx: StageContext, i: number): number => sceneFrames(ctx.manifest, ctx.fps)[i] / ctx.fps;

/** What scene i's sound is asked with: everything here is in its key. */
function soundAsk(ctx: StageContext, i: number) {
  const m = ctx.manifest;
  const spec = m.script!.scenes[i];
  const nonce = m.scenes[i].nonces.sound ?? 0;
  const sceneSec = sceneSeconds(ctx, i);
  return {
    prompt: spec.soundPrompt!,
    negativePrompt: SOUND_NEGATIVE_PROMPT,
    seed: soundSeed(m.request.seed ?? 0, i, nonce),
    guidanceScale: guidanceFor(spec.actionLevel),
    steps: SOUND_STEPS,
    audioLengthSec: soundAskSeconds(sceneSec),
    // the stored track: the scene's seconds, never longer (a scene under the worker's 1 s has its answer cut to it)
    trackSec: Math.round(Math.min(sceneSec, SCENE_SOUND_MAX_SEC) * 1000) / 1000,
    // (a scene longer than the model makes has its first seconds made and faded, plan ruling 5)
    fadeOut: sceneSec > SCENE_SOUND_MAX_SEC,
  };
}

/** The picture scene i's sound is heard from: its fitted video when it moves, its keyframe when it is a still. */
const pictureOf = (m: Manifest, i: number): string => (isStill(m, i) ? requireKeyframe(m.scenes[i]).path : requireFitted(m.scenes[i]).path);

const firstSoundScene = (m: Manifest): number => m.scenes.findIndex((x) => hasSceneSound(m, x.idx));

/**
 * Scene sound (phase 14 spec §3): each scene's sound is made by the Foley worker from what is seen in it (after `fit`, so
 * at the scene's final length), levelled to one loudness, and kept as `sound/scene_NN.wav`. Paid, per scene, keyed on
 * everything that changes the sound and on nothing that only changes how loud it is mixed (`sfxGain`).
 */
export const soundStage: Stage = {
  name: "sound",
  perScene: true,
  paid: true,
  appliesTo: hasSceneSound,
  deps: (m, scene) =>
    isStill(m, scene!)
      ? [{ stage: "keyframes", scene }, ...m.scenes.slice(0, scene! + 1).map((s) => ({ stage: "silence" as const, scene: s.idx }))]
      : [{ stage: "fit", scene }],
  async inputsFor(ctx, scene) {
    const i = scene!;
    // (the track's length and its fade are in the key too: a scene whose length crosses 10 s, or a still scene whose
    // length changes, has its track cut again rather than keep one of another length or without its fade)
    const ask = soundAsk(ctx, i);
    return { model: ctx.manifest.models.sound, ...ask, still: isStill(ctx.manifest, i), picture: await fileSha256(abs(ctx, pictureOf(ctx.manifest, i))) };
  },
  outputsFor: (_m, scene) => [paths.sound(scene!)],
  estimateCostUsd(ctx, scene) {
    const m = ctx.manifest;
    const s = m.scenes[scene!];
    // (before the voice the scene's length is unknown: the longest the model makes is assumed)
    const seconds = soundAskSeconds(s.audio ? s.audio.duration : SCENE_SOUND_MAX_SEC);
    return soundCost(ctx.prices, seconds, firstSoundScene(m) === scene);
  },
  async run(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const foley = ctx.providers.sound;
    if (!foley) throw new NonRetryableError("this run was made with scene sound, and no Foley endpoint is set for it");
    const ask = soundAsk(ctx, i);
    const input = await outPath(ctx, paths.soundInput(i));
    const picture = abs(ctx, pictureOf(m, i));
    const { width, height } = await probeVideo(picture);
    const size = soundInputSize(width, height);
    await ffmpeg(
      isStill(m, i)
        ? stillInputArgs(picture, input, { seconds: ask.audioLengthSec, ...size })
        : movingInputArgs(picture, input, { seconds: ask.audioLengthSec, ...size }),
    );
    // (as base64 inside the request: refused here, before anything is bought, rather than by the endpoint)
    const bytes = (await stat(input)).size;
    if (Math.ceil(bytes / 3) * 4 > MAX_INPUT_BYTES) {
      throw new NonRetryableError(`scene ${i + 1}'s video for its sound is ${(bytes / 1048576).toFixed(1)} MB; a request carries at most 9 MB`);
    }
    const { fadeOut, trackSec, ...request } = ask;
    const result = await runProviderJob(ctx, i, "sound", {
      label: `sound scene ${i + 1}`,
      costUsd: soundCost(ctx.prices, ask.audioLengthSec, firstSoundScene(m) === i),
      prepare: () => foley.prepare({ videoPath: input, ...request }),
      submit: (job, signal) => foley.submit(job, { signal }),
      wait: (id) => foley.wait(id, { timeoutMs: foley.waitMs ?? TIMEOUTS.video }),
      waitMs: foley.waitMs ?? TIMEOUTS.video,
      submitTimeoutMs: foley.submitMs,
    });
    const raw = await outPath(ctx, paths.soundRaw(i));
    const out = abs(ctx, paths.sound(i));
    await download(result.url, raw);
    await levelSound(raw, out, { seconds: trackSec, fadeOut, log: ctx.log });
    await rm(raw, { force: true });
    // (taken out of the bucket only once the levelled file is here: a failed pass downloads it again for nothing)
    await result.remove?.();
    m.scenes[i].sound = {
      path: paths.sound(i),
      sha256: await fileSha256(out),
      seconds: trackSec,
      seed: ask.seed,
      guidance: ask.guidanceScale,
      steps: ask.steps,
      prompt: ask.prompt,
    };
  },
};
