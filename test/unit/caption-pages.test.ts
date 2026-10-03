import { describe, expect, it } from "vitest";
import { captionPages, wordsToCaptions } from "../../src/media/remotion/caption-pages.js";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("wordsToCaptions", () => {
  const words = [w("one", 0, 0.3), w("two,", 0.3, 0.6), w("three", 0.7, 1), w("four", 1, 1.3), w("five", 1.3, 1.6)];

  it("breaks pages after punctuation or maxWordsPerPage words, never after the last word", () => {
    const captions = wordsToCaptions(words, 2);
    expect(captions.map((c) => [c.text, c.pageBreakAfter ?? false])).toEqual([
      ["one", false],
      [" two,", true],
      [" three", false],
      [" four", true],
      [" five", false],
    ]);
    expect(captions[2]).toMatchObject({ startMs: 700, endMs: 1000, timestampMs: null, confidence: null });
  });
});

describe("captionPages", () => {
  it("builds TikTok-style pages that each show until the next one starts", () => {
    const pages = captionPages(wordsToCaptions([w("one", 0, 0.3), w("two.", 0.3, 0.6), w("three", 0.8, 1.2)], 3));
    expect(pages.map((p) => [p.text, p.startMs, p.durationMs])).toEqual([
      ["one two.", 0, 800],
      ["three", 800, 400],
    ]);
    expect(pages[0].tokens.map((t) => t.text)).toEqual(["one", " two."]);
  });

  it("gives the last page a finite duration even when the library would not", () => {
    const pages = captionPages([
      { text: "solo", startMs: 0, endMs: 500, timestampMs: null, confidence: null, pageBreakAfter: true },
    ]);
    expect(pages[0].durationMs).toBe(500);
  });
});
