import { createHash } from "node:crypto";
import { FOLEY_RATES_MISSING, foleyRates, type Prices } from "./config.js";
import { round4 } from "./cost.js";

/*
 * Scene sound (phase 14 spec §3): the arithmetic of what each scene's sound is asked with, what it costs and how it is
 * levelled. Reads nothing and acts on nothing; the stage and the media helpers do.
 */

/** The longest sound the model is asked for; a longer scene has its first seconds made and faded (plan ruling 5). */
export const SCENE_SOUND_MAX_SEC = 10;
export const SOUND_STEPS = 50;
/** Always sent: the narration is the only voice of a video, and its music is the bed's. */
export const SOUND_NEGATIVE_PROMPT = "speech, voice, vocals, singing, music, narration, noise, distortion";
/** One loudness for every scene's sound, so a loud and a quiet answer end alike (a starting value, tuned by ear). */
export const LOUDNESS_TARGET_LUFS = -26;
/** How far the gain may move a sound: an answer quieter than this under the target is all but silence anyway. */
const MAX_GAIN_DB = 30;

export const guidanceFor = (level: "low" | "medium" | "high" | undefined): number => (level === "low" ? 3.5 : level === "high" ? 5.5 : 4.5);

/**
 * Scene i's seed: from the run's seed, the scene and the scene's reroll count, so the scenes of one run differ from
 * each other and a rerolled scene differs from what it was. Within the worker's 0…2^31−1.
 */
export function soundSeed(runSeed: number, scene: number, nonce: number): number {
  return createHash("sha256").update(`${runSeed}:${scene}:${nonce}`).digest().readUInt32BE(0) % 2 ** 31;
}

/** The seconds asked for: the scene's, to a tenth, and never more than the model makes. */
export const soundSeconds = (sceneSec: number): number => Math.min(Math.round(sceneSec * 10) / 10, SCENE_SOUND_MAX_SEC);

/** What `seconds` of sound costs: the GPU seconds measured for each second, and the worker's start for the first scene. */
export function soundCost(p: Prices, seconds: number, first = false): number {
  const r = foleyRates(p);
  if (!r) throw new Error(FOLEY_RATES_MISSING);
  return round4((seconds * r.secPerClipSec + (first ? r.coldStartSec : 0)) * r.usdPerSec);
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
