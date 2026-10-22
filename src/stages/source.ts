import type { Manifest } from "../manifest/schema.js";
import { paths } from "./paths.js";

/**
 * The clip file a Mode 1 scene plays (phase 11 spec §4): the full HD one (which is also the 60 fps one in a run that
 * asked for both: one job made it), else the smoothed one, else the clip as it was made. Pure, so `fit` can key and read
 * the same file.
 */
export function playedClip(m: Manifest, i: number): { stage: "clips" | "upscale" | "interpolate"; path: string } {
  if (m.request.upscale === true) return { stage: "upscale", path: paths.upscaled(i) };
  if (m.request.fps === 60) return { stage: "interpolate", path: paths.smoothed(i) };
  return { stage: "clips", path: paths.clip(i) };
}
