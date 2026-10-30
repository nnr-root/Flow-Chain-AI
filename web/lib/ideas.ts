import { z } from "zod";
import file from "@/content/ideas-price.json";

/** What one click costs, from the dated file the owner fills after measuring; `undefined` until then (and the button is not offered). */
const PriceFile = z.object({ usd: z.number().positive().max(5) });
export function ideasPriceUsd(raw: unknown = file): number | undefined {
  const parsed = PriceFile.safeParse(raw);
  return parsed.success ? parsed.data.usd : undefined;
}
export type IdeasResult = { ideas: Array<{ topic: string; why: string; sources: Array<{ title: string; url: string }> }>; dropped: number };
