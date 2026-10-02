import type { Size } from "../config.js";

export type CaptionWord = { text: string; start: number; end: number };

export const CAPTION_FONT = "Montserrat ExtraBold";
const HIGHLIGHT = "&H00E5FF&"; // ASS colours are BGR: this is yellow (255, 229, 0)
const BASE = "&HFFFFFF&";
const BREAK_AFTER = /[.,!?;:]$/;
const MIN_EVENT_SEC = 0.04;

export function paginate(words: CaptionWord[], maxWords = 3): CaptionWord[][] {
  const pages: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  for (const word of words) {
    current.push(word);
    if (current.length >= maxWords || BREAK_AFTER.test(word.text)) {
      pages.push(current);
      current = [];
    }
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

export function captionStyle(size: Size): { fontSize: number; marginV: number } {
  return size.height > size.width
    ? { fontSize: Math.round(size.width * 0.075), marginV: Math.round(size.height * 0.3) }
    : { fontSize: Math.round(size.height * 0.055), marginV: Math.round(size.height * 0.12) };
}

const clean = (text: string) => text.replace(/[{}\\]/g, "").toUpperCase();

export function wordsToAss(words: CaptionWord[], size: Size): string {
  const { fontSize, marginV } = captionStyle(size);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${size.width}`,
    `PlayResY: ${size.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Word,${CAPTION_FONT},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,6,0,2,60,60,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  for (const page of paginate(words)) {
    page.forEach((word, i) => {
      const next = page[i + 1];
      const end = Math.max(next ? next.start : word.end, word.start + MIN_EVENT_SEC);
      const text = page
        .map((p, j) => (j === i ? `{\\c${HIGHLIGHT}}${clean(p.text)}{\\c${BASE}}` : clean(p.text)))
        .join(" ");
      events.push(`Dialogue: 0,${assTime(word.start)},${assTime(end)},Word,,0,0,0,,${text}`);
    });
  }
  return `${[...header, ...events].join("\n")}\n`;
}
