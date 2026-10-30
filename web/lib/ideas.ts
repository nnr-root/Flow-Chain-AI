import { z } from "zod";
import file from "@/content/ideas-price.json";

/** What one click costs, from the dated file the owner fills after measuring; `undefined` until then (and the button is not offered). */
/*
 * The price is a whole number of ten-thousandths: the database rounds a hold to four decimals, and the worker runs a
 * request only when the hold equals the cap the command carries (within half a ten-thousandth). A price like 0.12345
 * would be held as 0.1235 and refused on every click, so it counts as no price and the button is not offered
 * (final review, F3). `multipleOf(0.0001)` is not used: it is float-fragile (0.0123 / 0.0001 is not a whole number).
 */
const PriceFile = z.object({
  usd: z.number().positive().max(5).refine((usd) => Math.abs(usd * 10_000 - Math.round(usd * 10_000)) < 1e-6, "a price is in ten-thousandths of a dollar"),
});
export function ideasPriceUsd(raw: unknown = file): number | undefined {
  const parsed = PriceFile.safeParse(raw);
  return parsed.success ? parsed.data.usd : undefined;
}
export type IdeasResult = { ideas: Array<{ topic: string; why: string; sources: Array<{ title: string; url: string }> }>; dropped: number };
