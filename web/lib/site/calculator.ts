import { z } from "zod";
import type { CatalogueItem } from "@/lib/billing";

/*
 * The landing page's arithmetic (Phase 4 spec §7). Pure, and the only place a price on that page is worked out:
 * the page states no figure this file did not compute, from the live catalogue, the showcase videos' own
 * receipts, and — for other companies — entries that say where and when their price was read.
 */

const cents = (usd: number): number => Math.round(usd * 100) / 100;

/** What a dollar of credit costs with this plan or top-up (credit is sold at a mark-up, and spent at cost). */
export const pricePerCreditDollar = (item: CatalogueItem): number => item.priceUsd / item.creditUsd;

export type Quote = {
  /** The plan (or, where no plan covers it, the top-ups) that pays for this many videos. */
  buy: Array<{ item: CatalogueItem; times: number }>;
  /** What that costs for the month. */
  monthUsd: number;
  /** The credit it grants, and how many videos that is. */
  creditUsd: number;
  videos: number;
  /** The month's price over the videos asked for: what one video comes to if exactly that many are made. */
  perVideoUsd: number;
};

/**
 * The cheapest way in the catalogue to pay for `videos` videos that use `creditPerVideoUsd` each: one plan
 * whose month of credit covers them, or top-ups, or the largest plan with top-ups beside it. Null when the
 * catalogue is empty or the numbers are no numbers.
 */
export function quote(videos: number, creditPerVideoUsd: number, items: CatalogueItem[]): Quote | null {
  if (!Number.isInteger(videos) || videos < 1 || !(creditPerVideoUsd > 0)) return null;
  // (in ten-thousandths, as credit is kept: 0.1 + 0.2 must cover 0.3)
  const need = Math.round(videos * creditPerVideoUsd * 10_000);
  const units = (i: CatalogueItem) => Math.round(i.creditUsd * 10_000);
  const plans = items.filter((i) => i.kind === "plan" && i.creditUsd > 0);
  const topups = items.filter((i) => i.kind === "topup" && i.creditUsd > 0).sort((a, b) => pricePerCreditDollar(a) - pricePerCreditDollar(b));
  /** Top-ups for `left` units of credit: as few of the best-priced as cover it, then the cheapest single one that covers what is over. */
  const withTopups = (left: number): Array<{ item: CatalogueItem; times: number }> | null => {
    if (left <= 0) return [];
    if (topups.length === 0) return null;
    const one = [...topups].sort((a, b) => a.priceUsd - b.priceUsd).find((t) => units(t) >= left);
    const best = topups[0];
    const many = { item: best, times: Math.ceil(left / units(best)) };
    return one && one.priceUsd <= many.times * best.priceUsd ? [{ item: one, times: 1 }] : [many];
  };
  const ways: Array<Array<{ item: CatalogueItem; times: number }>> = [];
  for (const plan of plans) {
    const rest = withTopups(need - units(plan));
    if (rest) ways.push([{ item: plan, times: 1 }, ...rest]);
  }
  const only = withTopups(need);
  if (only && only.length > 0) ways.push(only);
  if (ways.length === 0) return null;
  const priced = ways.map((buy) => ({ buy, monthUsd: buy.reduce((sum, b) => sum + b.item.priceUsd * b.times, 0), creditUsd: buy.reduce((sum, b) => sum + b.item.creditUsd * b.times, 0) }));
  // the cheapest; of two that cost the same, the one that grants more
  const pick = priced.sort((a, b) => a.monthUsd - b.monthUsd || b.creditUsd - a.creditUsd)[0];
  return { ...pick, monthUsd: cents(pick.monthUsd), creditUsd: cents(pick.creditUsd), videos: Math.floor(Math.round(pick.creditUsd * 10_000) / Math.round(creditPerVideoUsd * 10_000)), perVideoUsd: cents(pick.monthUsd / videos) };
}

/** Another company's price for generated video, as read from its own pricing page on a day. */
export const Comparison = z.object({
  name: z.string().min(1),
  plan: z.string().min(1),
  planUsdPerMonth: z.number().positive(),
  creditsPerMonth: z.number().positive(),
  model: z.string().min(1),
  /** As the company states it; empty when its pricing page does not say. */
  resolution: z.string(),
  creditsPerSecond: z.number().positive(),
  source: z.string().url().startsWith("https://"),
  checkedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type Comparison = z.infer<typeof Comparison>;

/** How long a price read from someone else's page is shown before it must be read again. */
export const FRESH_DAYS = 90;

/**
 * The entries that may be shown on `today`: well-formed, with a source, and read within the last 90 days. An
 * entry that fails any of these is left out — a stale or unsourced price is not shown with a caveat, it is not shown.
 */
export function freshComparisons(entries: unknown, today: Date): Comparison[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const parsed = Comparison.safeParse(entry);
    if (!parsed.success) return [];
    const age = (today.getTime() - Date.parse(`${parsed.data.checkedOn}T00:00:00Z`)) / 86_400_000;
    return age >= 0 && age <= FRESH_DAYS ? [parsed.data] : [];
  });
}

/** What a second of that company's video costs at its plan's price per credit. */
export const usdPerSecond = (c: Comparison): number => (c.planUsdPerMonth / c.creditsPerMonth) * c.creditsPerSecond;

/** What `seconds` of generated clips cost there: the clips alone, which is all that is sold there. */
export const clipsCostUsd = (c: Comparison, seconds: number): number => cents(usdPerSecond(c) * seconds);

/** The mean of some amounts, to the hundredth of a cent; 0 for none. */
export const mean = (amounts: number[]): number => (amounts.length === 0 ? 0 : Math.round((amounts.reduce((a, b) => a + b, 0) / amounts.length) * 10_000) / 10_000);
