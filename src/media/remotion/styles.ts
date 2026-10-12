import type { CaptionStyle, CaptionStyleName } from "./props.js";

/** Caption styles are data: style presets (2.2) and brand kits (2.3) override fields, never components. */
export const CAPTION_STYLES: Record<CaptionStyleName, CaptionStyle> = {
  hormozi: {
    font: { family: "Montserrat ExtraBold", file: "Montserrat-ExtraBold.ttf", weight: 800 },
    textCase: "upper",
    sizePctOfShortSide: 7.5,
    color: "#FFFFFF",
    activeColor: "#FFE500",
    inactiveOpacity: 1,
    stroke: { color: "#000000", pctOfSize: 12 }, // painted under the fill, so ≈ 6 % shows outside the glyphs
    shadow: null,
    maxWordsPerPage: 3,
    activeAnim: "none",
  },
  mrbeast: {
    font: { family: "Luckiest Guy", file: "LuckiestGuy-Regular.ttf", weight: 400 },
    textCase: "upper",
    sizePctOfShortSide: 8.5,
    color: "#FFFFFF",
    activeColor: "#3CFF5A",
    inactiveOpacity: 1,
    stroke: { color: "#000000", pctOfSize: 18 },
    shadow: "0 6px 0 rgba(0,0,0,0.85)",
    maxWordsPerPage: 2,
    activeAnim: "pop",
  },
  minimalist: {
    font: { family: "Inter SemiBold", file: "Inter-SemiBold.ttf", weight: 600 },
    textCase: "none",
    sizePctOfShortSide: 5.5,
    color: "#FFFFFF",
    activeColor: "#FFFFFF",
    inactiveOpacity: 0.6,
    stroke: null,
    shadow: "0 2px 12px rgba(0,0,0,0.6)",
    maxWordsPerPage: 6,
    activeAnim: "fade",
  },
};

/** Captions sit above TikTok/Shorts UI in portrait, lower in landscape (percent of height from the bottom). */
export function captionBottomPct(width: number, height: number): number {
  return height > width ? 30 : 12;
}

/**
 * The faces for scripts the caption styles' own faces do not have (phase 7 spec §17): a video in one of these
 * languages has its captions and hook set in its face, whatever the style (everything else of the style stays).
 * Noto Sans at extra-bold, made static from Google's variable files (OFL; assets/fonts/NotoSans-OFL.txt). Chinese
 * and Japanese share most characters but not their shapes, so each has its own.
 */
export const SCRIPT_FACES: Readonly<Record<string, CaptionStyle["font"]>> = {
  ja: { family: "Noto Sans JP ExtraBold", file: "NotoSansJP-ExtraBold.ttf", weight: 800 },
  zh: { family: "Noto Sans SC ExtraBold", file: "NotoSansSC-ExtraBold.ttf", weight: 800 },
  ko: { family: "Noto Sans KR ExtraBold", file: "NotoSansKR-ExtraBold.ttf", weight: 800 },
  hi: { family: "Noto Sans Devanagari ExtraBold", file: "NotoSansDevanagari-ExtraBold.ttf", weight: 800 },
  ar: { family: "Noto Sans Arabic ExtraBold", file: "NotoSansArabic-ExtraBold.ttf", weight: 800 },
};
