import localFont from "next/font/local";

/*
 * The one typeface of the whole site, a file in this folder (its open licence beside it): nothing is fetched
 * from anyone else. It is the face the studio's own captions are set in, which is the point: the site speaks
 * in the voice its videos do. Text is its medium weight; a title is its heaviest, in capitals, as a caption is.
 */
export const montserrat = localFont({ src: "./fonts/Montserrat.woff2", variable: "--font-montserrat", weight: "100 900", display: "swap" });

/*
 * The same file again, for titles: heavy capitals are far wider than the text Next measures its stand-in for,
 * and what stands in for them until the face arrives must be as wide (the theme's "Caption Fallback"), or a
 * title breaks into other lines at first and everything under it jumps when the face comes.
 */
export const montserratDisplay = localFont({
  src: "./fonts/Montserrat.woff2", variable: "--font-montserrat-display", weight: "100 900", display: "swap",
  adjustFontFallback: false, fallback: ["Caption Fallback", "Arial Black", "Arial", "sans-serif"],
});
