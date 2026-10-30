import { gainFor, LOUDNESS_TARGET_LUFS, parseLoudness } from "../sound.js";
import { ffmpeg } from "./ffmpeg.js";

/** At or under this ebur128 reports nothing but its gate's floor: the file is silent. */
const SILENT_LUFS = -70;
const FADE_SEC = 0.5;

/**
 * The levelling pass of a scene's sound (plan ruling 3): the first `seconds` (a no-op unless the answer runs long), a
 * fade-out on a track cut at the model's limit, the measured gain, then a limiter for the peaks. `level=false`:
 * alimiter levels its output to the limit by default, which undid the gain (-24 instead of -26 LUFS, 2026-10-31).
 */
export function levelArgs(input: string, out: string, o: { gainDb: number; seconds: number; fadeOut: boolean }): string[] {
  const filters = [
    `atrim=0:${o.seconds}`,
    ...(o.fadeOut ? [`afade=t=out:st=${Math.max(0, Math.round((o.seconds - FADE_SEC) * 1000) / 1000)}:d=${FADE_SEC}`] : []),
    `volume=${o.gainDb}dB`,
    "alimiter=limit=0.8:level=false",
  ];
  return ["-i", input, "-af", filters.join(","), "-ar", "48000", "-ac", "1", out];
}

/** Integrated loudness of a file in LUFS, or undefined when ffmpeg reports none. */
export async function measureLoudness(path: string): Promise<number | undefined> {
  return parseLoudness(await ffmpeg(["-i", path, "-af", "ebur128", "-f", "null", "-"], { logLevel: "info" }));
}

/**
 * Brings a scene's sound to one loudness (`LOUDNESS_TARGET_LUFS`) with a measured static gain: single-pass loudnorm is
 * unreliable on files of a few seconds (plan ruling 3). A silent answer gets no gain: none makes it a sound. `scene` is the
 * scene's number as a person counts it (from 1), for the log.
 */
export async function levelSound(
  input: string,
  out: string,
  o: { seconds: number; fadeOut: boolean; scene: number; log: (message: string) => void },
): Promise<{ measuredLufs?: number; gainDb: number }> {
  const measured = await measureLoudness(input);
  if (measured === undefined || !(measured > SILENT_LUFS)) {
    // (the scene, never the file's path: the line reaches a customer's job log, and a path names the machine)
    o.log(`scene ${o.scene}'s sound is silent (${measured ?? "no reading"} LUFS); kept without gain`);
    // (still cut to the scene: a track is never longer than its scene)
    await ffmpeg(levelArgs(input, out, { gainDb: 0, seconds: o.seconds, fadeOut: o.fadeOut }));
    return { gainDb: 0, ...(measured === undefined ? {} : { measuredLufs: measured }) };
  }
  const gainDb = gainFor(measured, LOUDNESS_TARGET_LUFS);
  await ffmpeg(levelArgs(input, out, { gainDb, seconds: o.seconds, fadeOut: o.fadeOut }));
  return { measuredLufs: measured, gainDb };
}
