import localFont from "next/font/local";

/*
 * What is printed on the site: text, labels, controls. A file in this folder (its open licence beside it):
 * nothing is fetched from anyone else.
 */
export const archivo = localFont({ src: "./fonts/Archivo.woff2", variable: "--font-archivo", weight: "100 900", display: "swap" });

/*
 * The hand: what is written on a board rather than printed on it. Titles, and the notes in red pencil beside a
 * panel (what a scene is, how long it runs, what it cost). What stands in for it until it arrives is the
 * theme's "Hand Fallback", shrunk to its narrow letters, so a title does not break differently and push the
 * page down when the face comes.
 */
export const hand = localFont({
  src: "./fonts/CoveredByYourGrace.woff2", variable: "--font-hand", weight: "400", display: "swap",
  adjustFontFallback: false, fallback: ["Hand Fallback", "Bradley Hand", "Segoe Print", "cursive"],
});
