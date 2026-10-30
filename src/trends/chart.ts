export type ChartItem = { title: string; channel: string; categoryId: string; views: number };

const CHART_MAX = 25;
const TEXT_MAX = 120;

// Line breaks and control characters become spaces so a title cannot start a line of its own in the prompt.
const clean = (v: unknown): string =>
  typeof v === "string" ? v.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim().slice(0, TEXT_MAX).trim() : "";

/** Reads the platform's most-popular answer; anything odd gives an empty chart, never an error. */
export function parseChart(raw: unknown): ChartItem[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: ChartItem[] = [];
  for (const it of items) {
    const snippet = (it as { snippet?: Record<string, unknown> } | null)?.snippet;
    const title = clean(snippet?.title);
    if (!title) continue;
    const views = Number((it as { statistics?: { viewCount?: unknown } }).statistics?.viewCount);
    out.push({
      title,
      channel: clean(snippet?.channelTitle),
      categoryId: typeof snippet?.categoryId === "string" ? snippet.categoryId.slice(0, 8) : "",
      views: Number.isFinite(views) && views >= 0 ? Math.floor(views) : 0,
    });
    if (out.length === CHART_MAX) break;
  }
  return out;
}
