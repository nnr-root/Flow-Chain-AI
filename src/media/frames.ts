import { rm, stat } from "node:fs/promises";
import type { Size } from "../config.js";
import { countFrames, ffmpeg } from "./ffmpeg.js";
import { type FitPlan, fitFilter } from "./fit.js";

async function nonEmpty(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

export async function extractFrame(video: string, index: number, out: string): Promise<void> {
  await ffmpeg(["-i", video, "-vf", `select=eq(n\\,${index})`, "-frames:v", "1", out]);
}

/**
 * The seam frame: the last frame that `applyFit(clip, …, plan, frames, size, fps)` shows, as a lossless PNG
 * at the output size, without encoding the fitted clip. It runs the identical fit filter chain and keeps
 * only output frame `frames - 1`, so the frame choice matches applyFit exactly for every plan (for "trim"
 * that is the source frame at output time (frames-1)/fps; for "slow"/"slow+freeze" the raw last frame).
 * An output-side `-ss` seek on the raw clip is not used: whenever fps conversion duplicates or drops frames
 * it lands one source frame off about half the time.
 */
export async function extractSeamFrame(
  clip: string,
  out: string,
  plan: FitPlan,
  frames: number,
  size: Size,
  fps: number,
): Promise<void> {
  await rm(out, { force: true });
  await ffmpeg(["-i", clip, "-vf", `${fitFilter(plan, size, fps)},trim=start_frame=${frames - 1}`, "-frames:v", "1", out]);
  if (!(await nonEmpty(out))) throw new Error(`could not extract the seam frame of ${clip} at frame ${frames - 1}`);
}

/**
 * Lossless PNG of the final decodable frame (used for the chain sheet's fitted-clip column).
 * Fast path decodes only the last second; the fallback counts frames and selects the last one.
 */
export async function extractLastFrame(video: string, out: string): Promise<void> {
  await rm(out, { force: true });
  try {
    await ffmpeg(["-sseof", "-1", "-i", video, "-update", "1", out]);
  } catch {
    // fall through to the exact path below
  }
  if (await nonEmpty(out)) return;
  const frames = await countFrames(video);
  await extractFrame(video, frames - 1, out);
  if (!(await nonEmpty(out))) throw new Error(`could not extract the last frame of ${video}`);
}
