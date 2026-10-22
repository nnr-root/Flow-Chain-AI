import { ffmpeg } from "../media/ffmpeg.js";

/** brightness, two colour axes, saturation, contrast: each from 0 to 1 (ffmpeg's signalstats, phase 10 spec §7). */
export type Look = [number, number, number, number, number];

const value = (log: string, key: string): number => {
  const m = new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.]+)`).exec(log);
  if (!m) throw new Error(`ffmpeg's statistics for ${key} are missing from its answer`);
  return Number(m[1]);
};

/** The look from the text ffmpeg's `signalstats,metadata=print` writes. */
export function parseStats(log: string): Look {
  const [yLow, yAvg, yHigh, uAvg, vAvg, sat] = ["YLOW", "YAVG", "YHIGH", "UAVG", "VAVG", "SATAVG"].map((k) => value(log, k));
  return [yAvg / 255, uAvg / 255, vAvg / 255, sat / 255, (yHigh - yLow) / 255];
}

export async function keyframeLook(path: string): Promise<Look> {
  const log = await ffmpeg(["-i", path, "-vf", "scale=64:64,signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"], { logLevel: "info" });
  return parseStats(log);
}

/** Euclidean distance between two looks. */
export function lookDistance(a: Look, b: Look): number {
  return Math.sqrt(a.reduce((sum, x, i) => sum + (x - b[i]) ** 2, 0));
}

/** The mean distance between neighbouring pictures: lower is a more alike run; 0 for fewer than two. */
export function consistency(looks: readonly Look[]): number {
  if (looks.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < looks.length; i++) total += lookDistance(looks[i - 1], looks[i]);
  return total / (looks.length - 1);
}

/**
 * Why two runs cannot be compared, or null when they can: the comparison is only fair for the same script made
 * twice (the same picture model and seed), and a run with fewer than two keyframes has no neighbours to compare.
 */
export function comparable(a: { keyframes: number; profile?: string; seed?: number }, b: { keyframes: number; profile?: string; seed?: number }): string | null {
  const few = (r: { keyframes: number }, which: string) => `the ${which} run has ${r.keyframes} keyframe${r.keyframes === 1 ? "" : "s"}; two runs with at least two each are needed`;
  if (a.keyframes < 2) return few(a, "first");
  if (b.keyframes < 2) return few(b, "second");
  if (a.profile !== b.profile) return `the runs were made with different picture models (${a.profile ?? "none recorded"} and ${b.profile ?? "none recorded"}); compare runs of one model`;
  if (a.seed !== b.seed) return `the runs have different seeds (${a.seed ?? "none recorded"} and ${b.seed ?? "none recorded"}); compare two runs of the same script and seed`;
  return null;
}
