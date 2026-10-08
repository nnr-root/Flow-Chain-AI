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
 * The cheapest way in the catalogue to pay for `videos` videos that use `creditPerVideoUsd` each: at most one
 * plan (a second cannot be bought) and any number of any top-ups beside it, or top-ups alone. Every such
 * combination is weighed; of two that cost the same, the one that grants more wins. Null when the catalogue
 * cannot cover them or the numbers are no numbers.
 */
export function quote(videos: number, creditPerVideoUsd: number, items: CatalogueItem[]): Quote | null {
  if (!Number.isInteger(videos) || videos < 1 || !(creditPerVideoUsd > 0)) return null;
  // (in ten-thousandths, as credit is kept: 0.1 + 0.2 must cover 0.3; prices in whole cents)
  const units = (i: CatalogueItem) => Math.round(i.creditUsd * 10_000);
  const price = (i: CatalogueItem) => Math.round(i.priceUsd * 100);
  const need = Math.round(videos * creditPerVideoUsd * 10_000);
  const plans = items.filter((i) => i.kind === "plan" && units(i) > 0);
  const topups = items.filter((i) => i.kind === "topup" && units(i) > 0);
  type Way = { buy: Array<{ item: CatalogueItem; times: number }>; cents: number; credit: number };
  let best: Way | null = null;
  const better = (w: Way) => best === null || w.cents < best.cents || (w.cents === best.cents && w.credit > best.credit);
  /** Every number of each top-up from `at` on that could matter, on top of what is already bought. */
  const fill = (at: number, way: Way): void => {
    if (way.credit >= need) {
      if (better(way)) best = way;
      return;
    }
    if (at >= topups.length || (best !== null && way.cents >= best.cents)) return;
    const item = topups[at];
    const most = Math.ceil((need - way.credit) / units(item));
    for (let times = most; times >= 0; times--) {
      fill(at + 1, times === 0 ? way : { buy: [...way.buy, { item, times }], cents: way.cents + times * price(item), credit: way.credit + times * units(item) });
    }
  };
  fill(0, { buy: [], cents: 0, credit: 0 });
  for (const plan of plans) fill(0, { buy: [{ item: plan, times: 1 }], cents: price(plan), credit: units(plan) });
  if (best === null) return null;
  const pick = best as Way;
  return {
    buy: pick.buy, monthUsd: pick.cents / 100, creditUsd: pick.credit / 10_000,
    videos: Math.floor(pick.credit / Math.round(creditPerVideoUsd * 10_000)), perVideoUsd: cents(pick.cents / 100 / videos),
  };
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
    // By the calendar day (in UTC), not the hour: fresh through the whole of its ninetieth day. A date one day
    // ahead is taken too — it is "today" for an owner east of Greenwich in the small hours.
    const days = Math.floor(today.getTime() / 86_400_000) - Math.floor(Date.parse(`${parsed.data.checkedOn}T00:00:00Z`) / 86_400_000);
    return days >= -1 && days <= FRESH_DAYS ? [parsed.data] : [];
  });
}

/** What a second of that company's video costs at its plan's price per credit. */
export const usdPerSecond = (c: Comparison): number => (c.planUsdPerMonth / c.creditsPerMonth) * c.creditsPerSecond;

/** What `seconds` of generated clips cost there: the clips alone, which is all that is sold there. */
export const clipsCostUsd = (c: Comparison, seconds: number): number => cents(usdPerSecond(c) * seconds);

/**
 * Whether the page may say that a finished video costs "about what others charge for the clips" (Phase 4 spec
 * D7: a claim only where the numbers bear it out). It may when, at the dearest rate credit is sold at here, a
 * typical video comes to no more than 15 % above what the cheapest of the other companies charges for the same
 * seconds of clips alone. Without prices here, or without a fresh price from anyone else, there is no claim.
 */
export function clipsClaimHolds(creditPerVideoUsd: number, clipSeconds: number, items: CatalogueItem[], others: Comparison[]): boolean {
  const sold = items.filter((i) => i.creditUsd > 0);
  if (sold.length === 0 || others.length === 0 || !(creditPerVideoUsd > 0) || !(clipSeconds > 0)) return false;
  const ours = creditPerVideoUsd * Math.max(...sold.map(pricePerCreditDollar));
  const theirs = Math.min(...others.map((c) => usdPerSecond(c) * clipSeconds));
  return ours <= theirs * 1.15;
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** A small count in words, as running text has it ("three videos"); figures beyond twelve. */
export const inWords = (n: number): string => (Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n));

/** The mean of some amounts, to the hundredth of a cent; 0 for none. */
export const mean = (amounts: number[]): number => (amounts.length === 0 ? 0 : Math.round((amounts.reduce((a, b) => a + b, 0) / amounts.length) * 10_000) / 10_000);
