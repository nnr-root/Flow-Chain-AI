/* Whether the studio takes payments, and what the pages and the server both need to know about them. No imports. */

/**
 * With `STRIPE_SECRET_KEY` set (and accounts, which billing needs) users can buy credit themselves. Without it
 * nothing of billing exists: no pricing page, no webhook, and credit is granted by hand as before.
 */
export const billingOn = (): boolean => !!process.env.STRIPE_SECRET_KEY?.trim() && !!process.env.DATABASE_URL?.trim();

/** One thing that can be bought: a subscription plan or a one-off top-up, as Stripe lists it. */
export type CatalogueItem = {
  priceId: string;
  kind: "plan" | "topup";
  /** The plan's or top-up's own name in `billing/plans.json` ("starter", "topup-10"). */
  key: string;
  name: string;
  /** What is paid (a month, for a plan). */
  priceUsd: number;
  /** What it grants. Less than the price: that difference is the studio's margin. */
  creditUsd: number;
};

export type PlanView = { plan: string; status: string; periodEnd: string | null; cancelAtPeriodEnd: boolean };
export type PaymentView = { id: string; kind: "plan" | "topup"; plan: string | null; paidUsd: number; creditUsd: number; refundedUsd: number; invoiceUrl: string | null; at: string };

/**
 * Whether a payment recorded at `paidAt` belongs to a purchase that began at `since` (the time in the address the
 * visitor came back to): it was recorded after the checkout was opened. No slack: a payment made a moment before
 * this purchase began must not pass for it, and paying takes longer than two clocks differ. An address older than
 * an hour is a bookmark, not a purchase, and `purchaseTime` says so.
 */
export function arrivedSince(paidAt: string | null | undefined, since: number): boolean {
  const at = paidAt ? Date.parse(paidAt) : Number.NaN;
  return Number.isFinite(at) && at >= since;
}

/** The `paid` of `/account?paid=<ms>`: when the purchase began, or null when it says nothing usable or is old. */
export function purchaseTime(paid: string | undefined, now = Date.now()): number | null {
  if (!paid || !/^\d{13}$/.test(paid)) return null;
  const since = Number(paid);
  return since <= now + 60_000 && now - since < 3600_000 ? since : null;
}

/** Subscription states in which the user has a plan (and may not buy a second one). */
export const LIVE = ["active", "trialing", "past_due"];
