/* Whether the studio takes payments, and what the pages and the server both need to know about them. No imports. */

/**
 * With `STRIPE_SECRET_KEY` set (and accounts, which billing needs) users can buy credit themselves. Without it
 * nothing of billing exists: no pricing page, no webhook, and credit is granted by hand as before.
 */
export const billingOn = (): boolean => !!process.env.STRIPE_SECRET_KEY?.trim() && !!process.env.SUPABASE_URL?.trim();

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

/** Subscription states in which the user has a plan (and may not buy a second one). */
export const LIVE = ["active", "trialing", "past_due"];
