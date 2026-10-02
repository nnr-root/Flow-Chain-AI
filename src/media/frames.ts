import { rm, stat } from "node:fs/promises";
import { countFrames, ffmpeg } from "./ffmpeg.js";

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
 * Lossless PNG of the final decodable frame (the chain image for the next Mode 1 scene).
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
