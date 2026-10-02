import { describe, expect, it } from "vitest";
import { assTime, captionStyle, paginate, wordsToAss } from "../../src/media/captions.js";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("paginate", () => {
  it("groups up to three words and breaks after punctuation", () => {
    const words = ["one", "two,", "three", "four", "five", "six", "seven."].map((t, i) => w(t, i, i + 1));
    expect(paginate(words).map((p) => p.map((x) => x.text))).toEqual([
      ["one", "two,"],
      ["three", "four", "five"],
      ["six", "seven."],
    ]);
  });
});

describe("assTime", () => {
  it("formats H:MM:SS.cc", () => {
    expect(assTime(65.237)).toBe("0:01:05.24");
    expect(assTime(3600)).toBe("1:00:00.00");
    expect(assTime(-1)).toBe("0:00:00.00");
  });
});

describe("captionStyle", () => {
  it("scales with the output size", () => {
    expect(captionStyle({ width: 1080, height: 1920 })).toEqual({ fontSize: 81, marginV: 576 });
    expect(captionStyle({ width: 1920, height: 1080 })).toEqual({ fontSize: 59, marginV: 130 });
  });
});

describe("wordsToAss", () => {
  const ass = wordsToAss(
    [w("one", 0, 0.4), w("two", 0.4, 0.8), w("three.", 0.8, 1.2), w("{four}", 1.5, 1.9)],
    { width: 1080, height: 1920 },
  );
  const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

  it("declares the play resolution and bundled font", () => {
    expect(ass).toContain("PlayResX: 1080\nPlayResY: 1920");
    expect(ass).toContain("Style: Word,Montserrat ExtraBold,81,");
  });

  it("emits one event per word with the active word highlighted", () => {
    expect(dialogues).toHaveLength(4);
    expect(dialogues[0]).toBe("Dialogue: 0,0:00:00.00,0:00:00.40,Word,,0,0,0,,{\\c&H00E5FF&}ONE{\\c&HFFFFFF&} TWO THREE.");
    expect(dialogues[1]).toBe("Dialogue: 0,0:00:00.40,0:00:00.80,Word,,0,0,0,,ONE {\\c&H00E5FF&}TWO{\\c&HFFFFFF&} THREE.");
  });

  it("ends the last word of a page at its own end and strips override braces", () => {
    expect(dialogues[2]).toBe("Dialogue: 0,0:00:00.80,0:00:01.20,Word,,0,0,0,,ONE TWO {\\c&H00E5FF&}THREE.{\\c&HFFFFFF&}");
    expect(dialogues[3]).toBe("Dialogue: 0,0:00:01.50,0:00:01.90,Word,,0,0,0,,{\\c&H00E5FF&}FOUR{\\c&HFFFFFF&}");
  });
});
