import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeDuration } from "../../src/media/ffmpeg.js";
import { removeSilence } from "../../src/media/silence.js";
import { makeAudio, tempDir } from "../helpers/media.js";

describe("removeSilence", () => {
  it("cuts interior and trailing silence to within 20 ms of the expected length", async () => {
    const dir = await tempDir();
    const input = join(dir, "in.wav");
    await makeAudio(input, [{ tone: 1 }, { silence: 0.6 }, { tone: 1, freq: 660 }, { silence: 0.3 }]);
    const out = join(dir, "out.wav");
    const r = await removeSilence(input, out);
    expect(r.keep).toHaveLength(2);
    expect(r.duration).toBeGreaterThan(2.22);
    expect(r.duration).toBeLessThan(2.26);
    expect(await probeDuration(out)).toBeCloseTo(r.duration, 3);
    expect(r.removedSec).toBeCloseTo(2.9 - r.duration, 3);
  });

  it("accepts MP3 input and trims leading silence", async () => {
    const dir = await tempDir();
    const input = join(dir, "in.mp3");
    await makeAudio(input, [{ silence: 0.5 }, { tone: 1 }]);
    const r = await removeSilence(input, join(dir, "out.wav"));
    expect(r.duration).toBeGreaterThan(1.03);
    expect(r.duration).toBeLessThan(1.13);
  });

  it("rejects audio that is entirely silent", async () => {
    const dir = await tempDir();
    const input = join(dir, "in.wav");
    await makeAudio(input, [{ silence: 1 }]);
    await expect(removeSilence(input, join(dir, "out.wav"))).rejects.toThrow(/entirely silent/);
  });
});
