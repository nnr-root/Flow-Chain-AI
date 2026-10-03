import { type Caption, createTikTokStyleCaptions } from "@remotion/captions";
import type { CaptionPage } from "./props.js";

export type TimedWord = { text: string; start: number; end: number };

const BREAK_AFTER = /[.,!?;:]$/;

/**
 * Word timings (seconds, on the narration timeline) → @remotion/captions `Caption[]`. A page ends after
 * punctuation or after `maxWordsPerPage` words. The last word never carries `pageBreakAfter` (the library
 * would leave that page's duration at Infinity).
 */
export function wordsToCaptions(words: TimedWord[], maxWordsPerPage: number): Caption[] {
  let onPage = 0;
  return words.map((w, i) => {
    onPage++;
    const isLast = i === words.length - 1;
    const pageBreakAfter = !isLast && (onPage >= maxWordsPerPage || BREAK_AFTER.test(w.text));
    if (pageBreakAfter) onPage = 0;
    return {
      text: i === 0 ? w.text : ` ${w.text}`,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
      timestampMs: null,
      confidence: null,
      ...(pageBreakAfter ? { pageBreakAfter: true } : {}),
    };
  });
}

/** TikTok-style pages (a page shows until the next one starts); every duration is finite. */
export function captionPages(captions: Caption[]): CaptionPage[] {
  const { pages } = createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: 1500 });
  return pages.map((p) => {
    const lastEnd = p.tokens.at(-1)?.toMs ?? p.startMs;
    return {
      text: p.text,
      startMs: p.startMs,
      durationMs: Number.isFinite(p.durationMs) ? p.durationMs : lastEnd - p.startMs,
      tokens: p.tokens.map((t) => ({ text: t.text, fromMs: t.fromMs, toMs: t.toMs })),
    };
  });
}
