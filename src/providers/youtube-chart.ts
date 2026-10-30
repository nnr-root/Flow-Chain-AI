import { type ChartItem, parseChart } from "../trends/chart.js";

/** The public most-popular chart for a region. Errors never carry the key or the address (they reach users' logs). */
export async function fetchChart(key: string, region: string, fetchFn: typeof fetch = fetch): Promise<ChartItem[]> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${encodeURIComponent(region)}&maxResults=25&key=${encodeURIComponent(key)}`;
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error("the chart is not available");
  }
  if (!res.ok) throw new Error(`the chart is not available (HTTP ${res.status})`);
  try {
    return parseChart(await res.json());
  } catch {
    throw new Error("the chart is not available");
  }
}
