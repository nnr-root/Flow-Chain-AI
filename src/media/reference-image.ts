import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg } from "./ffmpeg.js";

/**
 * A reference picture as it is sent to the picture worker (phase 10 spec §5): a JPEG whose longest side is at most
 * `maxSide`, never enlarged. Several full-size PNGs in one request body could pass RunPod's limit; a reference
 * is only there to carry a look, so this size loses nothing it is for.
 */
export async function shrinkReference(path: string, maxSide = 1024): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "flowchain-ref-"));
  const out = join(dir, "reference.jpg");
  try {
    await ffmpeg(["-y", "-i", path, "-vf", `scale=w=min(${maxSide}\\,iw):h=min(${maxSide}\\,ih):force_original_aspect_ratio=decrease`, "-q:v", "3", "-frames:v", "1", out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
