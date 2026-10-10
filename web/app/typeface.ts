import localFont from "next/font/local";

/*
 * The one typeface of the whole site, a file in this folder (its open licence beside it): nothing is fetched
 * from anyone else. It is a variable face with a width axis as well as a weight axis, and the site has two
 * voices from it: text at its normal width, and headings narrow and heavy, the way a caption is set on a video.
 */
export const archivo = localFont({ src: "./fonts/Archivo.woff2", variable: "--font-archivo", weight: "100 900", display: "swap" });

/*
 * The same file again, for headings: there it is drawn narrow, and what stands in for it until it arrives must
 * be narrow too (the theme's "Display Fallback"), or a headline breaks into more lines at first and everything
 * under it jumps when the face comes. Next's own stand-in is measured for the face at its normal width.
 */
export const archivoDisplay = localFont({
  src: "./fonts/Archivo.woff2", variable: "--font-archivo-display", weight: "100 900", display: "swap",
  adjustFontFallback: false, fallback: ["Display Fallback", "Arial Narrow", "Arial", "sans-serif"],
});
