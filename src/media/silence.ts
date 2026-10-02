import { rm } from "node:fs/promises";
import { ffmpeg, probeDuration } from "./ffmpeg.js";

export type Interval = { start: number; end: number };

const EPS = 1e-3;
const MIN_WORD_SEC = 0.04;

export function parseSilencedetect(stderr: string, total: number): Interval[] {
  const out: Interval[] = [];
  let open: number | undefined;
  for (const line of stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) {
      open = Math.max(0, Number(s[1]));
      continue;
    }
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (e && open !== undefined) {
      out.push({ start: open, end: Number(e[1]) });
      open = undefined;
    }
  }
  if (open !== undefined) out.push({ start: open, end: total });
  return out;
}

/**
 * Complement of the silences, keeping `padding` seconds of each silence next to speech.
 * Leading silence keeps only the padding before speech; trailing silence only the padding after it.
 */
export function keepSegments(silences: Interval[], total: number, padding = 0.08): Interval[] {
  const removed: Interval[] = [];
  for (const s of silences) {
    const start = s.start <= EPS ? 0 : s.start + padding;
    const end = s.end >= total - EPS ? total : s.end - padding;
    if (end - start > EPS) removed.push({ start, end });
  }
  removed.sort((a, b) => a.start - b.start);
  const keep: Interval[] = [];
  let cursor = 0;
  for (const r of removed) {
    if (r.start - cursor > EPS) keep.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (total - cursor > EPS) keep.push({ start: cursor, end: total });
  return keep;
}

/** Maps a time on the original timeline onto the trimmed one; times inside a cut snap to the cut point. */
export function remapTime(t: number, keep: Interval[]): number {
  let offset = 0;
  for (const seg of keep) {
    if (t < seg.start) return offset;
    if (t <= seg.end) return offset + (t - seg.start);
    offset += seg.end - seg.start;
  }
  return offset;
}

export function remapTimings<W extends { start: number; end: number }>(words: W[], keep: Interval[]): W[] {
  return words.map((w) => {
    const start = remapTime(w.start, keep);
    const end = Math.max(remapTime(w.end, keep), start + MIN_WORD_SEC);
    return { ...w, start, end };
  });
}

export type SilenceOptions = { noiseDb?: number; minSilence?: number; padding?: number };
export type SilenceResult = { keep: Interval[]; duration: number; removedSec: number };

/** Writes 48 kHz mono PCM WAV with internal/edge silences removed (sample-accurate atrim + concat). */
export async function removeSilence(input: string, output: string, opts: SilenceOptions = {}): Promise<SilenceResult> {
  const { noiseDb = -30, minSilence = 0.2, padding = 0.08 } = opts;
  const full = `${output}.full.wav`;
  await ffmpeg(["-i", input, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", full]);
  try {
    const total = await probeDuration(full);
    const log = await ffmpeg(["-i", full, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, "-f", "null", "-"], {
      logLevel: "info",
    });
    const keep = keepSegments(parseSilencedetect(log, total), total, padding);
    if (keep.length === 0) throw new Error(`${input} is entirely silent`);
    const chains = keep.map(
      (k, i) => `[0:a]atrim=start=${k.start.toFixed(6)}:end=${k.end.toFixed(6)},asetpts=PTS-STARTPTS[s${i}]`,
    );
    const joined = keep.map((_, i) => `[s${i}]`).join("");
    const filter = `${chains.join(";")};${joined}concat=n=${keep.length}:v=0:a=1[out]`;
    await ffmpeg(["-i", full, "-filter_complex", filter, "-map", "[out]", "-c:a", "pcm_s16le", output]);
    const duration = await probeDuration(output);
    return { keep, duration, removedSec: total - duration };
  } finally {
    await rm(full, { force: true });
  }
}
