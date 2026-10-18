import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeVideo } from "../../src/media/ffmpeg.js";
import { shrinkReference } from "../../src/media/reference-image.js";
import { makeImage, tempDir } from "../helpers/media.js";

async function sizeOf(bytes: Buffer, dir: string) {
  const file = join(dir, "check.jpg");
  await writeFile(file, bytes);
  const { width, height } = await probeVideo(file);
  return { width, height };
}

describe("a reference picture sent to the picture worker", () => {
  it("is shrunk so its longest side is at most 1024, keeping its shape", async () => {
    const dir = await tempDir();
    const big = join(dir, "big.png");
    await makeImage(big, { width: 2048, height: 1024 });
    expect(await sizeOf(await shrinkReference(big), dir)).toEqual({ width: 1024, height: 512 });
  });

  it("is never made larger", async () => {
    const dir = await tempDir();
    const small = join(dir, "small.png");
    await makeImage(small, { width: 320, height: 640 });
    expect(await sizeOf(await shrinkReference(small), dir)).toEqual({ width: 320, height: 640 });
  });
});
