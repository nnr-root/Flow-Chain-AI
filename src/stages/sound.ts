import { rm } from "node:fs/promises";
import { fileSha256 } from "../manifest/hash.js";
import type { Manifest } from "../manifest/schema.js";
import { extractAudio } from "../media/audio.js";
import { ffmpeg, probeDuration } from "../media/ffmpeg.js";
import { levelSound } from "../media/loudness.js";
import { NonRetryableError } from "../providers/retry.js";
import { LOUDNESS_TARGET_LUFS, RETIRED_SOUND_ENGINE, soundSeed } from "../sound.js";
import { abs, outPath, paths } from "./paths.js";
import { requireClip, requireFitted, requireKeyframe } from "./require.js";
import type { Stage, StageContext } from "./types.js";
import { durationDep, isSpeaking, sceneFrames } from "./visual.js";

/**
 * Whether scene i has a sound bought for it (phase 14 spec §3): only in a run made with scene sound and with sound effects
 * on, and only where the script wrote what is heard there (a prompt of nothing but spaces is none). No run is made with
 * scene sound any more (its worker was removed, phase 15 spec §13.12): this is an old run's, whose sounds are on disk, and
 * the stage refuses one it would have to buy.
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
 * (or may: a clip recovered without its answer is looked at when its sound is taken), in a run not made with scene sound.
 * An old run made with it keeps the sounds it bought (§6.3), in every scene: its clips' sounds were never listened to for
 * a voice, so none of them is laid under its pictures now. A speaking scene has none: its clip's sound already is its
 * voice, and laid down again it would be heard twice. Not tied to sound effects being on: it is made for nothing, so a
 * re-render that turns them on finds it there, and the render plays it only while they are on.
 * A clip in whose sound the worker heard a voice has none either (spec §13.10): the narrator is the only voice a
 * narrated video has, and silence is better than a stranger speaking over them. A false alarm (ambience heard as a word)
 * costs that scene only its ambience; a clip never listened to (made before the check) keeps its sound as before.
 */
export const hasClipSound = (m: Manifest, i: number): boolean =>
  m.request.videoProfile === "ltx25@1" &&
  m.request.sceneSound !== true &&
  m.scenes[i].mode === 1 &&
  !isSpeaking(m, i) &&
  m.scenes[i].clip?.hasAudio !== false &&
  m.scenes[i].clip?.voiceHeard !== true;

/** Whether scene i has a sound stage at all: an old run's sound bought for it, or its clip's own taken out of it. */
export const soundApplies = (m: Manifest, i: number): boolean => hasSceneSound(m, i) || hasClipSound(m, i);

const isStill = (m: Manifest, i: number) => m.scenes[i].mode === 2;

/** Scene i's length in the video, in seconds: its frames (what the fit made it, or what a still is shown for). */
const sceneSeconds = (ctx: StageContext, i: number): number => sceneFrames(ctx.manifest, ctx.fps, i)[i] / ctx.fps;

/*
 * The key an old run's bought sound was made on (phase 14 spec §3), frozen: a key that moved would make a finished run's
 * sound stale, and a stale one can no longer be bought (test/pipeline/foley-old-run.test.ts pins it as literals).
 */
const BOUGHT_NEGATIVE_PROMPT = "speech, voice, vocals, singing, music, narration, noise, distortion";
const BOUGHT_STEPS = 50;
/** The longest sound that worker made: a longer scene had its first seconds made, and faded. */
const BOUGHT_MAX_SEC = 10;
const boughtGuidance = (level: "low" | "medium" | "high" | undefined): number => (level === "low" ? 3.5 : level === "high" ? 5.5 : 4.5);
/** The seconds it was asked for: the scene's to a tenth, at least 1 and at most 10. */
const boughtAskSeconds = (sceneSec: number): number => Math.max(1, Math.min(Math.round(sceneSec * 10) / 10, BOUGHT_MAX_SEC));

/** The picture an old run's scene i's sound was heard from: its fitted video when it moves, its keyframe when it is a still. */
const pictureOf = (m: Manifest, i: number): string => (isStill(m, i) ? requireKeyframe(m.scenes[i]).path : requireFitted(m.scenes[i]).path);

/** What an old run's scene i's sound was bought on, in the order it was keyed. */
async function boughtKey(ctx: StageContext, i: number) {
  const m = ctx.manifest;
  const spec = m.script!.scenes[i];
  const sceneSec = sceneSeconds(ctx, i);
  return {
    model: m.models.sound,
    prompt: spec.soundPrompt!.trim(),
    negativePrompt: BOUGHT_NEGATIVE_PROMPT,
    seed: soundSeed(m.request.seed ?? 0, i, m.scenes[i].nonces.sound ?? 0),
    guidanceScale: boughtGuidance(spec.actionLevel),
    steps: BOUGHT_STEPS,
    audioLengthSec: boughtAskSeconds(sceneSec),
    trackSec: Math.round(Math.min(sceneSec, BOUGHT_MAX_SEC) * 1000) / 1000,
    fadeOut: sceneSec > BOUGHT_MAX_SEC,
    still: isStill(m, i),
    picture: await fileSha256(abs(ctx, pictureOf(m, i))),
  };
}

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
 * Scene sound (phase 15 spec §6): each ordinary scene of an LTX run has its sound taken out of its own clip, for nothing:
 * no provider, no charge, no ledger line. It is a stage of its own so that the render, the status and a re-render know one
 * place a scene's sound comes from. Keyed on the clip, the scene's length and the loudness, and on nothing that only
 * changes how loud it is mixed (`sfxGain`).
 * An old run made with scene sound (phase 14) bought its sounds from a worker that was removed (§13.12): they are on disk
 * and keyed as they were bought, so it re-renders for free; one that would have to be bought again is refused.
 */
export const soundStage: Stage = {
  name: "sound",
  perScene: true,
  // (paid, so a plan prices an old run's sound that is due, and that refuses before anything else runs)
  paid: true,
  appliesTo: soundApplies,
  deps: (m, scene) =>
    isStill(m, scene!)
      ? [{ stage: "keyframes", scene }, ...m.scenes.slice(0, scene! + 1).map((s) => durationDep(m, s.idx))]
      : [{ stage: "fit", scene }],
  async inputsFor(ctx, scene) {
    const i = scene!;
    if (hasSceneSound(ctx.manifest, i)) return boughtKey(ctx, i);
    // the clip's sound: the clip, the scene's frames at the video's rate (its length) and the loudness it is levelled to
    return {
      from: "clip",
      clip: await fileSha256(abs(ctx, requireClip(ctx.manifest.scenes[i]).path)),
      frames: sceneFrames(ctx.manifest, ctx.fps, i)[i],
      fps: ctx.fps,
      loudness: LOUDNESS_TARGET_LUFS,
    };
  },
  outputsFor: (_m, scene) => [paths.sound(scene!)],
  estimateCostUsd(ctx, scene) {
    if (hasSceneSound(ctx.manifest, scene!)) throw new NonRetryableError(RETIRED_SOUND_ENGINE);
    return 0;
  },
  async run(ctx, scene) {
    const i = scene!;
    if (hasSceneSound(ctx.manifest, i)) throw new NonRetryableError(RETIRED_SOUND_ENGINE);
    ctx.manifest.scenes[i].sound = await clipSound(ctx, i);
  },
};
