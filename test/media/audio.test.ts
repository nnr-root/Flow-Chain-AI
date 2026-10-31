import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { extractAudio, loudnessPass } from "../../src/media/audio.js";
import { ffmpeg, probeDuration } from "../../src/media/ffmpeg.js";
import { tempDir } from "../helpers/media.js";

describe("loudnessPass", () => {
  it("writes the normalised file to the output path and leaves no temp file behind", async () => {
    const dir = await tempDir();
    await ffmpeg([
      "-f", "lavfi", "-i", "color=black:s=64x64:r=30:d=1", "-f", "lavfi", "-i", "sine=f=440:d=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "in.mp4"),
    ]);
    await loudnessPass(join(dir, "in.mp4"), join(dir, "final.mp4"), 1.5);
    expect(await probeDuration(join(dir, "final.mp4"))).toBeCloseTo(1.5, 1);
    expect((await readdir(dir)).sort()).toEqual(["final.mp4", "in.mp4"]);
  });

  it("leaves an existing output untouched, and no temp file, when the pass fails", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "final.mp4"), "previous final");
    await expect(loudnessPass(join(dir, "missing.mp4"), join(dir, "final.mp4"), 1)).rejects.toThrow(/ffmpeg failed/);
    expect(await readFile(join(dir, "final.mp4"), "utf8")).toBe("previous final");
    expect(await readdir(dir)).toEqual(["final.mp4"]);
  });
});

describe("extractAudio", () => {
  it("writes a clip's sound as 48 kHz mono PCM, as long as the sound", async () => {
    const dir = await tempDir();
    await ffmpeg([
      "-f", "lavfi", "-i", "color=black:s=64x64:r=24:d=2", "-f", "lavfi", "-i", "sine=f=440:d=1.5",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, "in.mp4"),
    ]);
    expect(await extractAudio(join(dir, "in.mp4"), join(dir, "out.wav"))).toBe(true);
    const probe = await ffmpeg(["-i", join(dir, "out.wav"), "-f", "null", "-"], { logLevel: "info" });
    expect(probe).toMatch(/pcm_s16le.*48000 Hz, mono/);
    expect(await probeDuration(join(dir, "out.wav"))).toBeCloseTo(1.5, 1);
  });

  it("says so and writes nothing for a clip without sound", async () => {
    const dir = await tempDir();
    await ffmpeg(["-f", "lavfi", "-i", "color=black:s=64x64:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "in.mp4")]);
    expect(await extractAudio(join(dir, "in.mp4"), join(dir, "out.wav"))).toBe(false);
    expect(existsSync(join(dir, "out.wav"))).toBe(false);
  });
});
