import { editById } from "../edits.js";
import { fileSha256 } from "../manifest/hash.js";
import type { Manifest, SceneState } from "../manifest/schema.js";
import { extractAudio } from "../media/audio.js";
import { probeDuration } from "../media/ffmpeg.js";
import { planFit } from "../media/fit.js";
import { extractSeamFrame } from "../media/frames.js";
import { download } from "../providers/download.js";
import { TIMEOUTS } from "../providers/retry.js";
import type { VideoOutput } from "../providers/types.js";
import { soundSeed } from "../sound.js";
import { LTX_FPS, videoProfileOf } from "../video-profiles.js";
import { speechLanguage } from "../voice/language.js";
import { runProviderJob } from "./job.js";
import { settleWarmup } from "./warmup.js";
import { effectivePreset } from "./look.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip, requireScript } from "./require.js";
import { paramsOf, trimSpeech } from "./silence.js";
import type { Dep, RunContext, Stage, StageContext } from "./types.js";
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

/** The longest a speaking scene's sentence may run once trimmed (phase 15 spec §4, §5: 14 words were measured at 5–6 s). */
export const MAX_SPOKEN_SEC = 6.5;

/**
 * A speaking scene's clip length, asked for before anything of it is heard: the shortest LTX length (8k+1 frames at 24)
 * that holds the longest sentence allowed with half a second to spare, 169 frames. The scene is then as long as its
 * trimmed sentence, and the fit shortens the clip to it; a sentence is never cut to fit a clip.
 */
export const SPEAKING_CLIP_SEC = 169 / LTX_FPS;

/** The language a speaking scene's words are heard in: the video's, or for a run that asked for none, its script's. */
function spokenLanguage(m: Manifest, i: number): string {
  const language = m.request.language ?? speechLanguage(requireScript(m).scenes.map((s) => s.narration).join(" "));
  if (!language) throw new Error(`scene ${i + 1} speaks, and the video's language is not known: give the run a language`);
  return language;
}

/** The clip length scene i is bought at: a speaking scene's is fixed, every other scene's follows its trimmed voiceover. */
function clipSeconds(m: Manifest, i: number): number {
  return isSpeaking(m, i) ? SPEAKING_CLIP_SEC : videoProfileOf(m.request.videoProfile).clipSec(requireAudio(m.scenes[i]).duration);
}

/**
 * A speaking scene's audio, made from its clip as a narrator's line is made from its voiceover (phase 15 spec §13.2): the
 * clip's sound, its silence trimmed by the code that trims a voiceover, and the words the worker heard in it. A clip
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
  const audio = await trimSpeech(ctx, i, raw, clip.words);
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
      prompt: clipPrompt(script, i, effectivePreset(m), editById(m.request.edit), m.request.videoProfile),
      requestedSec: clipSeconds(m, i),
      // (only where the run chose a size: Wan 480p has none, so every earlier run's cache keys stay as they were)
      ...(profile.clipHeight ? { height: profile.clipHeight } : {}),
      // the seed decides the clip; only an LTX run sends one, so a Wan run's key is unchanged
      ...(seeded(m) ? { seed: clipSeed(m, i) } : {}),
      // a speaking scene's audio is made here too: its sentence, the language it is heard in and how it is trimmed decide it
      ...(isSpeaking(m, i) ? { speech: script.scenes[i].speech!.trim(), speechLanguage: spokenLanguage(m, i), silence: paramsOf(m) } : {}),
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
    const seconds = isSpeaking(ctx.manifest, scene!) ? SPEAKING_CLIP_SEC : profile.clipSec(s.audio ? s.audio.duration : Number.POSITIVE_INFINITY);
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
            prompt: clipPrompt(script, i, effectivePreset(m), editById(m.request.edit), m.request.videoProfile),
            durationSec: seconds,
            ...(profile.clipHeight ? { height: profile.clipHeight } : {}),
            ...(seeded(m) ? { seed: clipSeed(m, i, remake) } : {}),
            ...(language === undefined ? {} : { speechLanguage: language }),
          });
        },
        submit: (job, signal) => ctx.providers.video.submit(job, { signal }),
        wait: (id) => ctx.providers.video.wait(id, { timeoutMs: ctx.providers.video.waitMs ?? TIMEOUTS.video }),
        waitMs: ctx.providers.video.waitMs ?? TIMEOUTS.video,
        submitTimeoutMs: ctx.providers.video.submitMs,
      });
      made = result;
      await download(result.url, out);
      // the run has its own copy now: the one the worker uploaded is taken out of the bucket
      await result.remove?.();
      // the clip's own frame rate and sound, only where the provider told them (an LTX clip): a Wan clip's record is as it
      // was. A paid result reused after a stop keeps only its url, so an LTX clip's rate then comes from its profile
      // (one rate); whether it has sound is left unknown, never false.
      const fps = result.fps ?? (m.request.videoProfile === "ltx25@1" ? LTX_FPS : undefined);
      state.clip = {
        path: paths.clip(i),
        sourceUrl: result.url,
        duration: await probeDuration(out),
        requestedSec: seconds,
        ...(fps === undefined ? {} : { fps }),
        ...(result.hasAudio === undefined ? {} : { hasAudio: result.hasAudio }),
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
