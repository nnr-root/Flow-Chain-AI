/*
 * The hashtags a video is posted with (phase 7 spec §18). The script's model is asked for five, in the video's
 * language; what it sends is made into hashtags here rather than sent back, since every answer is paid for and a
 * hashtag is the easiest part of one to put right. Arithmetic only: read by the pipeline and the studio alike.
 */

/** How many a video is posted with. */
export const HASHTAGS = 5;

/**
 * Tags put on every video whatever it is about: they bring nobody who wants this one, and the model is told not
 * to use them. In the languages they are most used in.
 */
const GENERIC = new Set([
  "fyp", "foryou", "foryoupage", "fy", "viral", "viralvideo", "trending", "trend", "explore", "explorepage",
  "shorts", "short", "reels", "reel", "tiktok", "youtube", "youtubeshorts", "instagram", "video", "videos",
  "keşfet", "kesfet", "keşfetteyiz", "parati", "pourtoi", "fürdich", "perte", "virale",
]);

/**
 * What was sent, made into at most five hashtags: each one `#` and letters, marks or digits (no spaces or
 * punctuation, which end a hashtag on every platform), none generic, none twice (whatever their case), and none
 * that is only digits. Their order is kept: the model was asked for the broadest first.
 */
export function normalizeHashtags(sent: readonly string[] | undefined, most = HASHTAGS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const one of sent ?? []) {
    const body = one.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}_]/gu, "");
    const key = body.toLocaleLowerCase();
    if (!body || /^[\p{N}_]+$/u.test(body) || GENERIC.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(`#${body}`);
    if (out.length === most) break;
  }
  return out;
}
