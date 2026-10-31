import { rm, stat } from "node:fs/promises";
import { fileSha256 } from "../manifest/hash.js";
import type { Manifest } from "../manifest/schema.js";
import { extractAudio } from "../media/audio.js";
import { ffmpeg, probeDuration, probeVideo } from "../media/ffmpeg.js";
import { levelSound } from "../media/loudness.js";
import { movingInputArgs, soundInputSize, stillInputArgs } from "../media/sound-input.js";
import { download } from "../providers/download.js";
import { NonRetryableError, TIMEOUTS } from "../providers/retry.js";
import { MAX_INPUT_BYTES } from "../providers/runpod-providers.js";
import { guidanceFor, LOUDNESS_TARGET_LUFS, SCENE_SOUND_MAX_SEC, SOUND_NEGATIVE_PROMPT, SOUND_STEPS, soundAskSeconds, soundCost, soundSeed } from "../sound.js";
import { runProviderJob } from "./job.js";
import { abs, outPath, paths } from "./paths.js";
import { requireClip, requireFitted, requireKeyframe } from "./require.js";
import type { Stage, StageContext } from "./types.js";
import { durationDep, isSpeaking, sceneFrames } from "./visual.js";

/**
 * Whether scene i has a sound of its own made (phase 14 spec §3): only in a run made with scene sound and with sound
 * effects on, and only where the script wrote what is heard there (a prompt of nothing but spaces is none: it would buy a
 * sound asked for nothing). Before the script is written every scene is
 * counted, so the first plan prices the sound a run will buy.
 */
export const hasSceneSound = (m: Manifest, i: number): boolean =>
  m.request.sceneSound === true && m.request.render.sfx && (m.script ? Boolean(m.script.scenes[i]?.soundPrompt?.trim()) : true);

/**
 * A run made with scene sound some of whose scenes have no sound made, as it would be with sound effects on: what a
 * re-render cannot turn on (it buys nothing), so the studio says so before it starts one.
 */
export function soundNotMade(m: Manifest): boolean {
  const on: Manifest = { ...m, request: { ...m.request, render: { ...m.request.render, sfx: true } } };
  return m.scenes.some((s) => hasSceneSound(on, s.idx) && s.stages.sound?.status !== "done");
}

/**
 * Whether scene i's sound is its own clip's (phase 15 spec §6): an ordinary moving scene of an LTX run whose clip has sound
 * (or may: a clip recovered without its answer is looked at when its sound is taken), in a run made without Foley, which
 * wins wherever a run has it (§6.3). A speaking scene has none: its clip's sound already is its voice, and laid down again
 * it would be heard twice. Not tied to sound effects being on: it is made for nothing, so a re-render that turns them on
 * finds it there, and the render plays it only while they are on (as it does a Foley sound).
 */
export const hasClipSound = (m: Manifest, i: number): boolean =>
  m.request.videoProfile === "ltx25@1" &&
  m.request.sceneSound !== true &&
  m.scenes[i].mode === 1 &&
  !isSpeaking(m, i) &&
  m.scenes[i].clip?.hasAudio !== false;

/** Whether scene i has a sound stage at all: a Foley sound bought for it, or its clip's own taken out of it. */
export const soundApplies = (m: Manifest, i: number): boolean => hasSceneSound(m, i) || hasClipSound(m, i);

const isStill = (m: Manifest, i: number) => m.scenes[i].mode === 2;

/** Scene i's length in the video, in seconds: its frames (what the fit made it, or what a still is shown for). */
const sceneSeconds = (ctx: StageContext, i: number): number => sceneFrames(ctx.manifest, ctx.fps, i)[i] / ctx.fps;

/** What scene i's sound is asked with: everything here is in its key. */
function soundAsk(ctx: StageContext, i: number) {
  const m = ctx.manifest;
  const spec = m.script!.scenes[i];
  const nonce = m.scenes[i].nonces.sound ?? 0;
  const sceneSec = sceneSeconds(ctx, i);
  return {
    prompt: spec.soundPrompt!.trim(),
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

/** A clip sound that ends this much before its scene is faded out; one that ends closer is within the render's own ramp. */
const CLIP_SOUND_FADE_GAP_SEC = 0.1;

/**
 * Scene i's sound from its own clip (phase 15 spec §6): no provider and no charge. The clip's sound starts with its
 * picture, so its first seconds are what the fitted picture shows when the fit plan is `trim` (the one an LTX clip, asked
 * for at least its scene's length, gets). Where the clip was slowed to fit (`slow`, `slow+freeze`), the sound is still
 * never stretched or slowed (a slowed sound is lower and longer, and is heard as wrong at once): it plays at its own
 * speed from the scene's start and ends, faded, where the clip's sound ends. Only the sound is read out of the clip and
 * everything it carries goes with it; the clip itself is never written.
 */
async function clipSound(ctx: StageContext, i: number): Promise<NonNullable<Manifest["scenes"][number]["sound"]>> {
  const m = ctx.manifest;
  const raw = await outPath(ctx, paths.soundRaw(i));
  const out = abs(ctx, paths.sound(i));
  const sceneSec = sceneSeconds(ctx, i);
  if (await extractAudio(abs(ctx, requireClip(m.scenes[i]).path), raw)) {
    const heard = await probeDuration(raw);
    const seconds = Math.round(Math.min(sceneSec, heard) * 1000) / 1000;
    await levelSound(raw, out, { seconds, fadeOut: heard < sceneSec - CLIP_SOUND_FADE_GAP_SEC, scene: i + 1, log: ctx.log });
    await rm(raw, { force: true });
    return { path: paths.sound(i), sha256: await fileSha256(out), seconds, source: "clip" };
  }
  // (only a clip recovered without its answer can turn out to have no sound: it is kept as silence, so the stage is done
  // and is not tried again on every resume)
  ctx.log(`scene ${i + 1}'s clip has no sound of its own; its sound is silent`);
  const seconds = Math.round(sceneSec * 1000) / 1000;
  await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(seconds), "-ac", "1", "-ar", "48000", out]);
  return { path: paths.sound(i), sha256: await fileSha256(out), seconds, source: "clip" };
}

/**
 * Scene sound (phase 14 spec §3): each scene's sound is made by the Foley worker from what is seen in it (after `fit`, so
 * at the scene's final length), levelled to one loudness, and kept as `sound/scene_NN.wav`. Paid, per scene, keyed on
 * everything that changes the sound and on nothing that only changes how loud it is mixed (`sfxGain`).
 * In an LTX run without Foley the same stage takes each ordinary scene's sound out of its own clip instead (phase 15 spec
 * §6), for nothing: no provider, no charge, no ledger line. It is this stage and not one of its own so that the render,
 * the status and a re-render know one place a scene's sound comes from; a Foley scene is keyed and made exactly as before.
 */
export const soundStage: Stage = {
  name: "sound",
  perScene: true,
  paid: true,
  appliesTo: soundApplies,
  deps: (m, scene) =>
    isStill(m, scene!)
      ? [{ stage: "keyframes", scene }, ...m.scenes.slice(0, scene! + 1).map((s) => durationDep(m, s.idx))]
      : [{ stage: "fit", scene }],
  async inputsFor(ctx, scene) {
    const i = scene!;
    if (!hasSceneSound(ctx.manifest, i)) {
      // the clip's sound: the clip, the scene's frames at the video's rate (its length) and the loudness it is levelled to
      return {
        from: "clip",
        clip: await fileSha256(abs(ctx, requireClip(ctx.manifest.scenes[i]).path)),
        frames: sceneFrames(ctx.manifest, ctx.fps, i)[i],
        fps: ctx.fps,
        loudness: LOUDNESS_TARGET_LUFS,
      };
    }
    // (the track's length and its fade are in the key too: a scene whose length crosses 10 s, or a still scene whose
    // length changes, has its track cut again rather than keep one of another length or without its fade)
    const ask = soundAsk(ctx, i);
    return { model: ctx.manifest.models.sound, ...ask, still: isStill(ctx.manifest, i), picture: await fileSha256(abs(ctx, pictureOf(ctx.manifest, i))) };
  },
  outputsFor: (_m, scene) => [paths.sound(scene!)],
  estimateCostUsd(ctx, scene) {
    const m = ctx.manifest;
    // (a clip's own sound is taken out of it for nothing, and needs no Foley price)
    if (!hasSceneSound(m, scene!)) return 0;
    const s = m.scenes[scene!];
    // (before the voice the scene's length is unknown: the longest the model makes is assumed)
    const seconds = soundAskSeconds(s.audio ? s.audio.duration : SCENE_SOUND_MAX_SEC);
    return soundCost(ctx.prices, seconds, firstSoundScene(m) === scene);
  },
  async run(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    if (!hasSceneSound(m, i)) {
      m.scenes[i].sound = await clipSound(ctx, i);
      return;
    }
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
    await levelSound(raw, out, { seconds: trackSec, fadeOut, scene: i + 1, log: ctx.log });
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
