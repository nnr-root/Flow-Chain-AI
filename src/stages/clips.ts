import { stat } from "node:fs/promises";
import { editById } from "../edits.js";
import { fileSha256 } from "../manifest/hash.js";
import type { Manifest, SceneState } from "../manifest/schema.js";
import { cutTail, extractAudio } from "../media/audio.js";
import { clipDuration, probeDuration } from "../media/ffmpeg.js";
import { planFit } from "../media/fit.js";
import { extractSeamFrame } from "../media/frames.js";
import { TIMEOUTS } from "../providers/retry.js";
import type { VideoOutput } from "../providers/types.js";
import { soundSeed } from "../sound.js";
import { LTX_FPS, SPEAKING_MAX_FRAMES, speakingFrames, speakingRate, videoProfileOf } from "../video-profiles.js";
import { countUnits, firstRendition } from "../voice/words.js";
import { speechLanguage } from "../voice/language.js";
import { collect, runProviderJob } from "./job.js";
import { settleWarmup } from "./warmup.js";
import { effectivePreset } from "./look.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip, requireScript } from "./require.js";
import { clipFps, type Dep, type RunContext, type Stage, type StageContext } from "./types.js";
import { autoModeDeps, clipPrompt, durationDep, expectedOf, isSpeaking, needsKeyframe, sceneFrames } from "./visual.js";
import { clipFrames, inspect, MAX_REMAKES, noteRemake, remakeOf } from "./inspect.js";

/**
 * Writes the seam frame of clip i-1 (the last frame its fitted version shows, spec §4.7) and returns its
 * path. Free and deterministic from clip i-1, frames_{i-1}, size and fps, which is what clip i is keyed on.
 */
async function writeSeam(ctx: StageContext, i: number): Promise<string> {
  const prev = requireClip(ctx.manifest.scenes[i - 1]);
  const frames = sceneFrames(ctx.manifest, ctx.fps, i - 1)[i - 1];
  const plan = planFit(prev.duration, frames / ctx.fps);
  const seam = await outPath(ctx, paths.seam(i - 1));
  await extractSeamFrame(abs(ctx, prev.path), seam, plan, frames, ctx.size, ctx.fps);
  return seam;
}

/**
 * Scene i's clip seed on LTX, which the worker requires (the Wan worker picks its own): from the run's seed, the scene and
 * its reroll count, as a scene's sound seed is (one function, so the two cannot drift), so a clip asked for again is the
 * same clip and a rerolled scene is a new one. A malformed clip's remake `r` is seeded from that seed and `r`, so it is
 * never the first clip again, nor the clip a later reroll would make.
 */
export function clipSeed(m: Manifest, i: number, remake = 0): number {
  const seed = soundSeed(m.request.seed ?? 0, i, m.scenes[i].nonces.clips ?? 0);
  return remake === 0 ? seed : soundSeed(seed, i, remake);
}

/** Only an LTX clip is asked with a seed of the studio's; a Wan clip is asked as it always was. */
const seeded = (m: Manifest): boolean => m.request.videoProfile === "ltx25@1";

/** The longest a speaking scene may run once its tail is cut (phase 15 spec §4, §5, §13.6: 14 words were measured at 5–6 s). */
export const MAX_SPOKEN_SEC = 6.5;

/**
 * A speaking scene's clip length, asked for before anything of it is heard (phase 15 spec §13.6): from its sentence, about
 * its time and a second more, since LTX fills a longer clip by saying the sentence again. A run frozen before that (no
 * `speakingClip`) is asked as it was, at the longest, 169 frames, so its paid clip keeps its key. The scene is then as long
 * as its sentence, and the fit shortens the clip to it; a sentence is never cut to fit a clip. Every reader of a speaking
 * clip's length (the stage, its estimate, the modes, a draft's price, the restorer's estimates) asks here.
 */
export function speakingClipSec(m: Manifest, i: number): number {
  if (m.request.speakingClip !== "sentence") return SPEAKING_MAX_FRAMES / LTX_FPS;
  const said = m.script?.scenes[i]?.speech?.trim();
  // (at the pace of the video's language: a Turkish sentence of as many words takes longer to say)
  return speakingFrames(said ? countUnits(said, m.request.language) : undefined, speakingRate(m.request.language)) / LTX_FPS;
}

/**
 * Where a speaking scene's sound is cut (phase 15 spec §13.6): 0.4 s after its last kept word, and when the clip said the
 * sentence again, 50 ms before the next saying begins, so none of it is heard and the mouth does not start it; never
 * before the last kept word ends, nor after the sound itself ends.
 */
export function speechCutSec(heard: ReadonlyArray<{ start: number; end: number }>, kept: ReadonlyArray<{ end: number }>, audioSec: number): number {
  const last = kept.at(-1)!.end;
  const next = heard[kept.length];
  const end = Math.min(last + SPEECH_TAIL_SEC, next ? next.start - 0.05 : Number.POSITIVE_INFINITY);
  return Math.min(audioSec, Math.max(last, end));
}

/**
 * How much of a speaking clip's sound is kept after its last word: its last syllable decays after the moment the worker
 * says the word ends, and the fade at the cut needs room inside that, not inside the word.
 */
export const SPEECH_TAIL_SEC = 0.4;
/** The fade into that cut (the silence stage's `endFadeMs` for a voiceover's end). */
const SPEECH_END_FADE_SEC = 0.04;

/** The language a speaking scene's words are heard in: the video's, or for a run that asked for none, its script's. */
function spokenLanguage(m: Manifest, i: number): string {
  const language = m.request.language ?? speechLanguage(requireScript(m).scenes.map((s) => s.narration).join(" "));
  if (!language) throw new Error(`scene ${i + 1} speaks, and the video's language is not known: give the run a language`);
  return language;
}

/** The clip length scene i is bought at: a speaking scene's from its sentence, every other scene's follows its trimmed voiceover. */
function clipSeconds(m: Manifest, i: number): number {
  return isSpeaking(m, i) ? speakingClipSec(m, i) : videoProfileOf(m.request.videoProfile).clipSec(requireAudio(m.scenes[i]).duration);
}

/**
 * A speaking scene's audio (phase 15 spec §13.2, §13.6): the clip's own sound, never cut at its start or inside, since the
 * picture plays from its first frame and a cut there would put the voice ahead of the lips; only its end is cut, a
 * moment after the last word, and the fit then cuts the clip's picture at the same point. The words are the worker's,
 * at the times it heard them: nothing before them was removed. A clip
 * that cannot give all of that fails the scene with what to do: it is paid for already, and nothing is guessed (no
 * speech is shown without its captions) or bought again here.
 */
async function speakingAudio(ctx: RunContext, i: number, clip: VideoOutput): Promise<NonNullable<SceneState["audio"]>> {
  const again = "make the scene's clip again";
  if (clip.words === undefined) throw new Error(`scene ${i + 1}: this scene's clip came back without its speech words; ${again}`);
  const raw = await outPath(ctx, paths.clipAudio(i));
  if (clip.hasAudio === false || !(await extractAudio(abs(ctx, paths.clip(i)), raw))) {
    throw new Error(`scene ${i + 1}: its clip came back with no sound; ${again}`);
  }
  if (clip.words.length === 0) throw new Error(`scene ${i + 1}: no words were heard in its clip; ${again}`);
  // (a clip that said its sentence twice keeps the first: the second never reaches the captions or the sound)
  const language = ctx.manifest.request.language;
  const said = countUnits(requireScript(ctx.manifest).scenes[i].speech ?? "", language);
  const words = firstRendition(clip.words, said, language);
  if (words.length < clip.words.length) ctx.log(`scene ${i + 1}: its clip says the sentence again after ${words.at(-1)!.end.toFixed(2)} s; only the first is kept`);
  // (and a clip that stopped before its sentence ended is not shown as if it had said it; a word or two the listener
  // missed or merged is not that)
  if (words.length < said - 2) throw new Error(`scene ${i + 1}'s sentence was cut off by its clip; ${again}`);
  const whole = await probeDuration(raw);
  const end = speechCutSec(clip.words, words, whole);
  await cutTail(raw, await outPath(ctx, paths.audio(i)), end, SPEECH_END_FADE_SEC);
  const duration = await probeDuration(abs(ctx, paths.audio(i)));
  const audio = { path: paths.audio(i), duration, words, removedSec: Math.max(0, whole - duration) };
  if (audio.duration > MAX_SPOKEN_SEC) throw new Error(`scene ${i + 1}'s sentence does not fit; the script wrote too many words`);
  return audio;
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
    // (a speaking scene's own length is made here, from its clip: it waits for no voiceover of its own)
    const deps: Dep[] = [{ stage: "script" }, ...(isSpeaking(m, i) ? [] : [durationDep(m, i)]), ...autoModeDeps(m)];
    if (needsKeyframe(m, i)) deps.push({ stage: "keyframes", scene: i });
    // A continuing clip starts from clip i-1's seam frame, which depends on frames_{i-1} (durations 0..i-1).
    else deps.push({ stage: "clips", scene: i - 1 });
    // A seam frame is rendered at frames_{i-1}, which depends on every earlier duration.
    if (!needsKeyframe(m, i)) for (let k = 0; k < i; k++) deps.push(durationDep(m, k));
    return deps;
  },
  async inputsFor(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const script = requireScript(m);
    const profile = videoProfileOf(m.request.videoProfile);
    const base = {
      mode: 1,
      model: m.models.video,
      prompt: clipPrompt(script, i, effectivePreset(m), editById(m.request.edit), m.request.videoProfile, isSpeaking(m, i)),
      requestedSec: clipSeconds(m, i),
      // (only where the run chose a size: Wan 480p has none, so every earlier run's cache keys stay as they were)
      ...(profile.clipHeight ? { height: profile.clipHeight } : {}),
      // the seed decides the clip; only an LTX run sends one, so a Wan run's key is unchanged
      ...(seeded(m) ? { seed: clipSeed(m, i) } : {}),
      // a speaking scene's audio is made here too: its sentence, the language it is heard in and how it is trimmed decide it
      ...(isSpeaking(m, i) ? { speech: script.scenes[i].speech!.trim(), speechLanguage: spokenLanguage(m, i), tailSec: SPEECH_TAIL_SEC } : {}),
    };
    if (needsKeyframe(m, i)) return { ...base, imageSha: await fileSha256(abs(ctx, paths.keyframe(i))) };
    // The seam file does not exist yet when this is hashed; key on everything that determines it instead.
    return {
      ...base,
      seam: {
        prevClipSha: await fileSha256(abs(ctx, requireClip(m.scenes[i - 1]).path)),
        prevFrames: sceneFrames(m, ctx.fps, i - 1)[i - 1],
        size: ctx.size,
        fps: ctx.fps,
      },
    };
  },
  outputsFor: (m, scene) => (isSpeaking(m, scene!) ? [paths.clip(scene!), paths.clipAudio(scene!), paths.audio(scene!)] : [paths.clip(scene!)]),
  estimateCostUsd(ctx, scene) {
    const profile = videoProfileOf(ctx.manifest.request.videoProfile);
    // before the audio exists, assume the longest clip the profile buys; the first clip also pays the cold start
    const first = ctx.manifest.scenes.findIndex((x) => x.mode === 1) === scene;
    const s = ctx.manifest.scenes[scene!];
    const seconds = isSpeaking(ctx.manifest, scene!) ? speakingClipSec(ctx.manifest, scene!) : profile.clipSec(s.audio ? s.audio.duration : Number.POSITIVE_INFINITY);
    const clip = profile.costUsd(ctx.prices, seconds);
    return clip + (first ? profile.runOverheadUsd(ctx.prices) : 0);
  },
  async run(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const state = m.scenes[i];
    const script = requireScript(m);
    const out = await outPath(ctx, paths.clip(i));

    const profile = videoProfileOf(m.request.videoProfile);
    const seconds = clipSeconds(m, i);
    const speaking = isSpeaking(m, i);
    const language = speaking ? spokenLanguage(m, i) : undefined;
    // An ordinary LTX scene is listened to for a voice the prompt asked it not to make (phase 15 spec §13.10); not in an old
    // run made with scene sound, where a clip's own sound is never used (its bought sounds win, §6.3). Not part of the
    // clip's key: only what is done with the clip's sound depends on it.
    const checkVoice = seeded(m) && !speaking && m.request.sceneSound !== true;
    // (an earlier clip's sound is not this one's: until this clip gives the scene its audio, the scene has none)
    if (speaking) delete state.audio;
    let made: VideoOutput | undefined;
    // the worker's early start (asked for while the pictures were made) is paid for with the first clip after it
    await settleWarmup(ctx);
    // each clip is looked at before it is fitted, upscaled or carried on from, and made again once when it is
    // malformed (phase 8 spec §9): the Wan worker picks a new seed for every job, an LTX remake is sent a new one
    for (let remake = remakeOf(ctx, i, "clips"); ; remake++) {
      const jobCtx = { ...ctx, inputHash: remake === 0 ? ctx.inputHash : `${ctx.inputHash}#${remake}` };
      const result = await runProviderJob(jobCtx, i, "clips", {
        label: `clip scene ${i + 1}${remake ? ` (made again, ${remake})` : ""}`,
        costUsd: profile.costUsd(ctx.prices, seconds),
        prepare: async () => {
          // the chain image: the scene's own keyframe, or the seam frame of the previous clip
          const imagePath = needsKeyframe(m, i) ? abs(ctx, paths.keyframe(i)) : await writeSeam(ctx, i);
          return ctx.providers.video.prepare({
            imagePath,
            prompt: clipPrompt(script, i, effectivePreset(m), editById(m.request.edit), m.request.videoProfile, speaking),
            durationSec: seconds,
            ...(profile.clipHeight ? { height: profile.clipHeight } : {}),
            ...(seeded(m) ? { seed: clipSeed(m, i, remake) } : {}),
            ...(language === undefined ? {} : { speechLanguage: language }),
            ...(checkVoice ? { detectVoice: true } : {}),
          });
        },
        submit: (job, signal) => ctx.providers.video.submit(job, { signal }),
        wait: (id) => ctx.providers.video.wait(id, { timeoutMs: ctx.providers.video.waitMs ?? TIMEOUTS.video }),
        waitMs: ctx.providers.video.waitMs ?? TIMEOUTS.video,
        submitTimeoutMs: ctx.providers.video.submitMs,
      });
      made = result;
      // (a kept result from before sizes were written: the clip already here is taken only if it is as long as was asked)
      await collect(jobCtx, i, "clips", result, out, async () => {
        const size = await stat(out).then((f) => f.size).catch(() => 0);
        return size > 0 && Math.abs((await clipDuration(out)) - seconds) <= 1 / (result.fps ?? clipFps({}));
      });
      // the run has its own copy now: the one the worker uploaded is taken out of the bucket
      await result.remove?.();
      // the clip's own frame rate and sound, only where the provider told them (an LTX clip): a Wan clip's record is as it
      // was. A paid result reused after a stop keeps its rate, sound and words with it (they are saved in the job's
      // result); only one recovered from the bucket without the worker's answer has its url alone: its rate then comes from
      // its profile (one rate), and whether it has sound is left unknown, never false.
      const fps = result.fps ?? (m.request.videoProfile === "ltx25@1" ? LTX_FPS : undefined);
      // A clip that was asked to be checked and came back without the answer (recovered from the bucket after RunPod forgot
      // the job) has an unchecked sound: it is taken as carrying a voice, so that scene loses only its ambience and a
      // stranger's voice can never reach the video.
      const voiceHeard = result.voiceHeard ?? (checkVoice ? true : undefined);
      state.clip = {
        path: paths.clip(i),
        sourceUrl: result.url,
        // (its picture's length: an LTX clip's sound may run a little past it)
        duration: await clipDuration(out),
        requestedSec: seconds,
        ...(fps === undefined ? {} : { fps }),
        ...(result.hasAudio === undefined ? {} : { hasAudio: result.hasAudio }),
        // (unknown only where no check was asked: a speaking scene, a run with scene sound, a Wan clip)
        ...(voiceHeard === undefined ? {} : { voiceHeard }),
      };
      if (remake >= (MAX_REMAKES.clips ?? 0)) break;
      const look = await clipFrames(out, abs(ctx, `frames/look_${i + 1}`));
      const verdict = await inspect(ctx, look.files, expectedOf(script, i)).finally(look.done);
      if (verdict.ok) break;
      ctx.log(`clip scene ${i + 1} is malformed (${verdict.problems.join("; ")}): making it again`);
      await noteRemake(ctx, i, "clips", remake + 1);
    }
    if (speaking) state.audio = await speakingAudio(ctx, i, made!);
  },
};
