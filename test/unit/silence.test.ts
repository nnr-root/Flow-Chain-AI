import { describe, expect, it } from "vitest";
import { keepSegments, parseSilencedetect, remapTimings } from "../../src/media/silence.js";

const STDERR = `[Parsed_silencedetect_0 @ 0x7b91004e40] silence_start: 0.999917
[Parsed_silencedetect_0 @ 0x7b91004e40] silence_end: 1.600062 | silence_duration: 0.600146
[Parsed_silencedetect_0 @ 0x7b91004e40] silence_start: 2.599958
[Parsed_silencedetect_0 @ 0x7b91004e40] silence_end: 2.9 | silence_duration: 0.300042`;

describe("parseSilencedetect", () => {
  it("pairs starts and ends", () => {
    expect(parseSilencedetect(STDERR, 2.9)).toEqual([
      { start: 0.999917, end: 1.600062 },
      { start: 2.599958, end: 2.9 },
    ]);
  });

  it("closes an unterminated silence at the end of the file", () => {
    expect(parseSilencedetect("x silence_start: 2.5\n", 3)).toEqual([{ start: 2.5, end: 3 }]);
  });

  it("clamps negative starts to zero", () => {
    expect(parseSilencedetect("silence_start: -0.0213\nsilence_end: 0.4 | d", 3)).toEqual([{ start: 0, end: 0.4 }]);
  });
});

describe("keepSegments", () => {
  it("keeps 80 ms around speech for interior and trailing silences", () => {
    const keep = keepSegments(parseSilencedetect(STDERR, 2.9), 2.9);
    expect(keep).toHaveLength(2);
    expect(keep[0].start).toBe(0);
    expect(keep[0].end).toBeCloseTo(1.079917, 6);
    expect(keep[1].start).toBeCloseTo(1.520062, 6);
    expect(keep[1].end).toBeCloseTo(2.679958, 6);
  });

  it("trims leading silence down to the padding", () => {
    const keep = keepSegments([{ start: 0, end: 0.5 }], 1.5);
    expect(keep).toHaveLength(1);
    expect(keep[0].start).toBeCloseTo(0.42, 6);
    expect(keep[0].end).toBe(1.5);
  });

  it("drops silences shorter than twice the padding", () => {
    expect(keepSegments([{ start: 1, end: 1.15 }], 2)).toEqual([{ start: 0, end: 2 }]);
  });

  it("keeps everything when there is no silence", () => {
    expect(keepSegments([], 2)).toEqual([{ start: 0, end: 2 }]);
  });

  it("keeps nothing when the whole file is silent", () => {
    expect(keepSegments([{ start: 0, end: 2 }], 2)).toEqual([]);
  });
});

describe("remapTimings", () => {
  const keep = [
    { start: 0, end: 1 },
    { start: 1.5, end: 2.5 },
  ];

  it("shifts words after a cut and snaps times inside a cut to its edge", () => {
    const out = remapTimings(
      [
        { text: "a", start: 0.2, end: 0.8 },
        { text: "b", start: 1.2, end: 1.7 },
        { text: "c", start: 1.6, end: 2.0 },
        { text: "d", start: 2.4, end: 2.6 },
      ],
      keep,
    );
    expect(out.map((w) => [w.text, +w.start.toFixed(3), +w.end.toFixed(3)])).toEqual([
      ["a", 0.2, 0.8],
      ["b", 1.0, 1.2],
      ["c", 1.1, 1.5],
      ["d", 1.9, 2.0],
    ]);
  });

  it("gives a word that falls entirely inside a cut a 40 ms span", () => {
    const [w] = remapTimings([{ text: "e", start: 1.1, end: 1.3 }], keep);
    expect(w.start).toBeCloseTo(1.0, 6);
    expect(w.end).toBeCloseTo(1.04, 6);
  });
});
