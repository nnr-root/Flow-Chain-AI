import { extname } from "node:path";

/* The pure parts of `npm run make:showcase` (Phase 4 spec §6.1): what a finished run cost, and how its files are published small. */

export type LedgerEntry = { stage: string; usd: number };
export type ReceiptLine = { label: "Script" | "Voice" | "Pictures" | "Clips" | "Other"; usd: number };
export type Receipt = {
  /** What was bought, in the order a video is made. Lines that cost nothing are left out. */
  lines: ReceiptLine[];
  /** The sum of the lines: the credit the video used. */
  totalUsd: number;
  /**
   * Whether the pictures and clips were made the way the studio makes them now, on its own GPU ("own"), or on
   * the hosted models it used before ("hosted"). Which models those are is never published (phase 5 spec §7).
   */
  madeOn: "own" | "hosted";
  /** The height its clips were generated at (480), where the run's own record says. */
  clipHeight?: number;
};

const LINE_OF: Record<string, ReceiptLine["label"]> = { script: "Script", tts: "Voice", reference: "Pictures", keyframes: "Pictures", clips: "Clips" };
const ORDER: ReceiptLine["label"][] = ["Script", "Voice", "Pictures", "Clips", "Other"];
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** What a run cost, grouped the way a video is made. Every figure comes from the run's own ledger. */
export function receiptOf(ledger: LedgerEntry[], models: { llm: string; tts: string; image: string; video: string }, videoProfile?: string): Receipt {
  const sums = new Map<ReceiptLine["label"], number>();
  for (const entry of ledger) {
    if (!Number.isFinite(entry.usd) || entry.usd < 0) throw new Error(`the ledger has an entry that is no amount (${entry.stage})`);
    const label = LINE_OF[entry.stage] ?? "Other";
    sums.set(label, (sums.get(label) ?? 0) + entry.usd);
  }
  // the run's own choice where it made one (its profile says the height), else what the graph's name says
  const height = /-(\d{3,4})p@/.exec(videoProfile ?? "") ?? /^runpod:[^/]+\/[a-z0-9-]*?-(\d{3,4})p@/i.exec(models.video);
  const lines = ORDER.filter((label) => (sums.get(label) ?? 0) > 0).map((label) => ({ label, usd: round4(sums.get(label)!) }));
  return {
    lines,
    totalUsd: round4(lines.reduce((sum, line) => sum + line.usd, 0)),
    madeOn: /^runpod:/i.test(models.video) ? "own" : "hosted",
    // (the graph's name carries the height it generates at; the endpoint's id before it is nobody's business)
    ...(height ? { clipHeight: Number(height[1]) } : {}),
  };
}

export type Publication = { from: string; to: string; how: "video" | "picture" | "narration" | "copy" };

/**
 * How each of a run's published files goes onto the page: clips and pictures made small (the page shows them
 * at phone size), the narration as MP3, everything else — fonts, the logo, sounds, music — as it is. `from` is
 * the path the render props use; `to` is the same path, with the extension of what it becomes.
 */
export function publications(published: string[]): Publication[] {
  return published.map((from) => {
    const ext = extname(from).toLowerCase();
    const swap = (to: string) => `${from.slice(0, from.length - ext.length)}${to}`;
    if (ext === ".mp4" || ext === ".mov" || ext === ".webm") return { from, to: swap(".mp4"), how: "video" as const };
    // the run's own pictures, that is: a brand's logo may be a PNG too, and must keep its transparency
    if (from.startsWith("images/") && (ext === ".png" || ext === ".jpg" || ext === ".jpeg")) return { from, to: swap(".jpg"), how: "picture" as const };
    if (ext === ".wav") return { from, to: swap(".mp3"), how: "narration" as const };
    return { from, to: from, how: "copy" as const };
  });
}

/**
 * The render props with every published path replaced by what it was published as. Only values that are
 * exactly a published path change: a hook title that happens to contain "clip.mp4" is somebody's words.
 */
export function republish<T>(props: T, pubs: Publication[]): T {
  const to = new Map(pubs.map((p) => [p.from, p.to]));
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return to.get(value) ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(props) as T;
}

/**
 * A recording as a row of bars: the loudest moment of each of `buckets` equal stretches, from 0 to 1 against
 * the loudest of all. Enough to draw the voice as it was spoken.
 */
export function peaksOf(samples: Int16Array, buckets: number): number[] {
  if (samples.length === 0 || buckets < 1) return [];
  const peaks = Array.from({ length: buckets }, (_, b) => {
    const from = Math.floor((b * samples.length) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * samples.length) / buckets));
    let peak = 0;
    for (let i = from; i < to && i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    return peak;
  });
  const loudest = Math.max(...peaks);
  return peaks.map((p) => (loudest === 0 ? 0 : Math.round((p / loudest) * 100) / 100));
}

/** How a video was made, stage by stage: what the "how a video is made" strip shows of a real run. */
export type Making = {
  topic: string;
  /** The script, scene by scene: what is said, for how long, and whether the picture moves. */
  scenes: Array<{ narration: string; seconds: number; kind: "clip" | "still"; thumb: string }>;
  voice: { seconds: number; peaks: number[] };
};

/** A showcase's name in an address: lower-case letters, digits and dashes. */
export function slugOf(text: string | undefined): string {
  if (!text || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(text)) throw new Error("--slug must be a short name in lower-case letters, digits and dashes");
  return text;
}
