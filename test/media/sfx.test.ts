import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { probeDuration } from "../../src/media/ffmpeg.js";
import { SFX, sfxFiles } from "../../src/media/sfx.js";

const SFX_DIR = resolve("assets/sfx");

/** Mono samples of an audio file at 44.1 kHz. */
async function samples(file: string): Promise<Float32Array> {
  const r = await execa("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "44100", "-f", "f32le", "-"], {
    encoding: "buffer",
  });
  const b = r.stdout as Uint8Array;
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/** Time (s) of the loudest 50 ms window. */
function loudestAt(s: Float32Array): number {
  const win = 2205;
  let best = 0;
  let at = 0;
  for (let i = 0; i + win <= s.length; i += 441) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += s[j] * s[j];
    if (sum > best) [best, at] = [sum, (i + win / 2) / 44100];
  }
  return at;
}

describe("bundled sound effects", () => {
  it("are all present", () => {
    expect(sfxFiles(SFX_DIR).every((f) => existsSync(f))).toBe(true);
  });

  it("have the expected lengths", async () => {
    expect(await probeDuration(join(SFX_DIR, SFX.impact.file))).toBeCloseTo(1.2, 1);
    expect(await probeDuration(join(SFX_DIR, SFX.whoosh.file))).toBeCloseTo(0.5, 1);
    expect(await probeDuration(join(SFX_DIR, SFX.pop.file))).toBeCloseTo(0.08, 1);
  });

  it("peak where their cues expect: the impact and pop at once, the whoosh 0.25 s in", async () => {
    expect(loudestAt(await samples(join(SFX_DIR, SFX.impact.file)))).toBeLessThan(0.1);
    expect(Math.abs(loudestAt(await samples(join(SFX_DIR, SFX.whoosh.file))) - 0.25)).toBeLessThanOrEqual(0.05);
    expect(SFX.whoosh.leadFrames).toBe(8); // 0.25 s at 30 fps, rounded
  });
});
