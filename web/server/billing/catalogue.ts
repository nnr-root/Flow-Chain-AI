import type { CatalogueItem } from "@/lib/billing";
import { ApiError } from "../http";
import { type StripeApi, StripeError, stripeApi, usdOf } from "@src/billing/stripe";

/* What can be bought: the studio's active prices as Stripe lists them. Stripe is the source of truth; this is a short-lived copy. */

type Price = {
  id: string; unit_amount: number | null; currency: string; recurring: { interval: string } | null;
  metadata: Record<string, string>; product: { name?: string; active?: boolean } | string;
};

const TTL_MS = 5 * 60_000;
let cached: { at: number; items: CatalogueItem[] } | undefined;

/** One Stripe price as something to buy, or null when it is not the studio's or lacks what the studio needs to know. */
export function catalogueItem(price: Price): CatalogueItem | null {
  const meta = price.metadata ?? {};
  const credit = Number(meta.credit_usd);
  if (meta.studio !== "flowchain" || !meta.key || !meta.credit_usd || !Number.isFinite(credit) || credit < 0) return null;
  if (price.currency !== "usd" || typeof price.unit_amount !== "number") return null;
  // a plan is billed by the month; anything recurring otherwise is not something the studio sells
  if (price.recurring && price.recurring.interval !== "month") return null;
  const product = typeof price.product === "object" ? price.product : {};
  if (product.active === false) return null;
  return { priceId: price.id, kind: price.recurring ? "plan" : "topup", key: meta.key, name: product.name ?? meta.key, priceUsd: usdOf(price.unit_amount), creditUsd: credit };
}

export async function fetchCatalogue(stripe: StripeApi): Promise<CatalogueItem[]> {
  const prices = await stripe.list<Price>("/v1/prices", { active: true, expand: ["data.product"] });
  return prices.map(catalogueItem).filter((item): item is CatalogueItem => item !== null).sort((a, b) => (a.kind === b.kind ? a.priceUsd - b.priceUsd : a.kind === "plan" ? -1 : 1));
}

/** The catalogue, at most five minutes old. */
export async function catalogue(now = Date.now()): Promise<CatalogueItem[]> {
  if (cached && now - cached.at < TTL_MS) return cached.items;
  const stripe = stripeApi();
  if (!stripe) throw new ApiError("not_found", "this studio takes no payments");
  try {
    cached = { at: now, items: await fetchCatalogue(stripe) };
  } catch (err) {
    console.error("billing:", err instanceof StripeError ? err.message : String(err));
    // an older copy is better than none while Stripe is away
    if (cached) return cached.items;
    throw new ApiError("billing_unavailable", "payments are not available right now", "try again in a moment");
  }
  return cached.items;
}

/** Tests only. */
export const forgetCatalogue = (): void => {
  cached = undefined;
};
