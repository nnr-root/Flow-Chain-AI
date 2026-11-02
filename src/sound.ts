import { createHash } from "node:crypto";

/*
 * A scene's sound: the seed a scene's clip is asked with, and the loudness every scene's sound is levelled to. Reads
 * nothing and acts on nothing; the stages and the media helpers do. (A sound bought from the scene-sound worker of phase
 * 14 is gone with that worker, phase 15 spec §13.12: what an old run of it still needs is in the sound stage.)
 */

/** One loudness for every scene's sound, so a loud and a quiet clip end alike (a starting value, tuned by ear). */
export const LOUDNESS_TARGET_LUFS = -26;
/** How far the gain may move a sound: a clip quieter than this under the target is all but silence anyway. */
const MAX_GAIN_DB = 30;

/**
 * What a run made with scene sound (phase 14) is told when a sound of its would have to be bought again: the worker that
 * made it was removed (phase 15 spec §13.12). It says the way on: a finished run re-renders, and a draft (or a run whose
 * sounds were never made) is made with its sound effects turned off, since then no sound is due. It reaches a customer's
 * job log, so it names no model, setting or provider.
 */
export const RETIRED_SOUND_ENGINE =
  "this run's scene sounds came from a sound engine this studio no longer uses; it can be re-rendered, or made with its sound effects turned off, but no sound can be bought for it";

/**
 * Scene i's seed: from the run's seed, the scene and the scene's reroll count, so the scenes of one run differ from
 * each other and a rerolled scene differs from what it was. Within the worker's 0…2^31−1. The clips stage asks each clip
 * with it, and an old run's bought sounds are keyed on it: it never changes.
 */
export function soundSeed(runSeed: number, scene: number, nonce: number): number {
  return createHash("sha256").update(`${runSeed}:${scene}:${nonce}`).digest().readUInt32BE(0) % 2 ** 31;
}

/**
 * The integrated loudness `ffmpeg -af ebur128` reports in its summary, in LUFS. Only the summary's: the running lines
 * carry an `I:` too, of the audio heard so far.
 */
export function parseLoudness(ebur128Output: string): number | undefined {
  const m = /Integrated loudness:\s*\n\s*I:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*LUFS/.exec(ebur128Output);
  if (!m) return undefined;
  return m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
}

/** The static gain that brings `measuredLufs` to the target, in dB, within ±30. */
export function gainFor(measuredLufs: number, targetLufs = LOUDNESS_TARGET_LUFS): number {
  const gain = Math.round((targetLufs - measuredLufs) * 100) / 100;
  return Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, gain));
}
