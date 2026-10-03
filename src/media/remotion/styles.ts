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
