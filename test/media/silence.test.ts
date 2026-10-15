import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeDuration } from "../../src/media/ffmpeg.js";
import { outsideWords, removeSilence } from "../../src/media/silence.js";
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

describe("trimming a line so that no word is cut (phase 7 spec §22)", () => {
  // a line that trails off: a full sound, then its last syllable 38 dB under it, then silence
  const trailingOff = async () => {
    const dir = await tempDir();
    const input = join(dir, "in.wav");
    await makeAudio(input, [{ tone: 1 }, { tone: 0.5, freq: 330, db: -38 }, { silence: 0.6 }]);
    return { dir, input };
  };

  it("took a soft last syllable for silence when silence was -30 dBFS (how runs before it are trimmed)", async () => {
    const { dir, input } = await trailingOff();
    const old = await removeSilence(input, join(dir, "old.wav"));
    expect(old.duration).toBeLessThan(1.2);
  });

  it("keeps it when silence is measured under the line's own loudest", async () => {
    const { dir, input } = await trailingOff();
    const kept = await removeSilence(input, join(dir, "new.wav"), { belowPeakDb: 45, padding: 0.1, fadeMs: 5 });
    expect(kept.duration).toBeGreaterThan(1.55);
    expect(kept.duration).toBeLessThan(1.65);
  });

  it("never cuts into a word, whatever the detector hears", async () => {
    const { dir, input } = await trailingOff();
    // even at -30 dBFS, a word said from 0.9 to 1.45 s keeps its soft end
    const guarded = await removeSilence(input, join(dir, "guard.wav"), { noiseDb: -30, words: [{ start: 0, end: 0.9 }, { start: 0.9, end: 1.45 }] });
    expect(guarded.duration).toBeGreaterThan(1.5);
  });
});

describe("silences outside the words", () => {
  it("are what the detector heard, with every word (and its decay) taken out", () => {
    const words = [{ start: 0, end: 1 }, { start: 1.2, end: 2 }];
    expect(outsideWords([{ start: 0.5, end: 1.5 }, { start: 2.5, end: 3 }], words, 0.05)).toEqual([
      { start: 1.05, end: 1.2 },
      { start: 2.5, end: 3 },
    ]);
  });
});
