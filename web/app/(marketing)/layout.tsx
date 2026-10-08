import type { Metadata } from "next";
import localFont from "next/font/local";
import "./site.css";

/*
 * The marketing side's root layout (Phase 4 spec §4). The studio has its own, in (studio)/: two root layouts,
 * so going from one side to the other loads a new page, and no style, font or script of one reaches the other.
 * The fonts are files in this folder (open licences beside them): nothing is fetched from anyone else.
 */
const fraunces = localFont({ src: "./fonts/Fraunces.woff2", variable: "--font-fraunces", weight: "100 900", display: "swap" });
const schibsted = localFont({ src: "./fonts/SchibstedGrotesk.woff2", variable: "--font-schibsted", weight: "400 900", display: "swap" });
const plexMono = localFont({
  src: [{ path: "./fonts/IBMPlexMono-Regular.woff2", weight: "400" }, { path: "./fonts/IBMPlexMono-Medium.woff2", weight: "500" }],
  variable: "--font-plex-mono", display: "swap",
});

export const metadata: Metadata = {
  title: "Flow Chain — type a topic, get a finished short video",
  description: "Flow Chain writes the script, records the voice, generates the pictures and cuts a captioned short video to the words. You see the cost before anything is bought.",
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${schibsted.variable} ${plexMono.variable}`}>
      <body className="min-h-screen" data-surface="site">{children}</body>
    </html>
  );
}
