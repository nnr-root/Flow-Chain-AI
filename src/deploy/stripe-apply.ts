import { API_VERSION, creditOf, EVENT_TYPES, type StripeApi, usdOf } from "../billing/stripe.js";
import { type Endpoint, type Listing, planWebhook, priceParams, type Step } from "./stripe-setup.js";

/* The part of `npm run stripe:setup` that talks to Stripe: reading what is there and carrying out the steps. */

type Product = { id: string; name: string; active: boolean; metadata?: Record<string, string> };
type Price = {
  id: string; product: string | { id: string }; unit_amount: number | null; currency: string;
  recurring: { interval: string } | null; metadata?: Record<string, string>;
};
const STUDIO = "flowchain";

/** The studio's own active products and prices. What else lives in the account is left alone, unseen. */
export async function readListing(stripe: StripeApi): Promise<Listing> {
  const [products, prices] = await Promise.all([
    stripe.list<Product>("/v1/products", { active: true }),
    stripe.list<Price>("/v1/prices", { active: true }),
  ]);
  const ours = <T extends { metadata?: Record<string, string> }>(o: T) => o.metadata?.studio === STUDIO && !!o.metadata.key;
  return {
    products: products.filter(ours).map((p) => ({ id: p.id, key: p.metadata!.key, name: p.name })),
    prices: prices.filter(ours).map((p) => {
      return {
        id: p.id, productId: typeof p.product === "string" ? p.product : p.product.id, key: p.metadata!.key,
        kind: p.recurring ? ("plan" as const) : ("topup" as const), priceUsd: usdOf(p.unit_amount),
        // a price in another currency, or one that does not say what it grants, matches nothing wanted
        creditUsd: p.currency === "usd" ? creditOf(p.metadata) : null,
      };
    }),
  };
}

/** Carries the steps out, in order. A price is created on the product made (or found) for its key. */
export async function applySteps(stripe: StripeApi, steps: Step[], existing: Listing, log: (line: string) => void = () => {}): Promise<void> {
  // the first product of a key, as the planner has it
  const productOf = new Map<string, string>();
  for (const p of existing.products) if (!productOf.has(p.key)) productOf.set(p.key, p.id);
  for (const step of steps) {
    if (step.do === "create-product") {
      const made = await stripe.post<{ id: string }>("/v1/products", { name: step.name, metadata: { studio: STUDIO, key: step.key } });
      productOf.set(step.key, made.id);
    } else if (step.do === "rename-product") await stripe.post(`/v1/products/${step.productId}`, { name: step.name });
    else if (step.do === "create-price") {
      const product = productOf.get(step.key);
      if (!product) throw new Error(`there is no product for ${step.key} to put the price on`);
      await stripe.post("/v1/prices", priceParams(step, product));
    } else if (step.do === "archive-price") await stripe.post(`/v1/prices/${step.priceId}`, { active: false });
    else await stripe.post(`/v1/products/${step.productId}`, { active: false });
    log(step.do);
  }
}

/**
 * The Customer Portal as the studio's users see it: cancelling ends the plan with the month that was paid for,
 * and switching plans charges nothing in between — the new plan's price and credit start with the next month's
 * invoice. Created once and brought up to date after that. Returns its id.
 */
export async function ensurePortal(stripe: StripeApi, listing: Listing): Promise<string> {
  const plans = listing.prices.filter((p) => p.kind === "plan");
  const byProduct = new Map<string, string[]>();
  for (const p of plans) byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p.id]);
  const params = {
    business_profile: { headline: "Flow-Chain Studio" },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: plans.length > 1
        ? { enabled: true, default_allowed_updates: ["price"], proration_behavior: "none", products: [...byProduct].map(([product, prices]) => ({ product, prices })) }
        : { enabled: false },
    },
    metadata: { studio: STUDIO },
  };
  const all = await stripe.list<{ id: string; metadata?: Record<string, string> }>("/v1/billing_portal/configurations", { active: true });
  const ours = all.find((c) => c.metadata?.studio === STUDIO);
  return (await stripe.post<{ id: string }>(ours ? `/v1/billing_portal/configurations/${ours.id}` : "/v1/billing_portal/configurations", params)).id;
}

/**
 * Makes sure Stripe sends the studio's events to `url`. `secretOf` is the endpoint whose signing secret this
 * machine holds. When a new endpoint has to be made, `keep` is handed its id and secret at once (Stripe shows
 * the secret only then) and must store them; only after that are the old endpoints removed, so nothing that goes
 * wrong later can lose the one copy. Returns whether an endpoint was made.
 */
export async function ensureWebhook(stripe: StripeApi, url: string, secretOf: string | undefined, keep: (made: { id: string; secret: string }) => void): Promise<boolean> {
  const endpoints = await stripe.list<Endpoint>("/v1/webhook_endpoints");
  const plan = planWebhook(endpoints, url, EVENT_TYPES, API_VERSION, secretOf);
  if (plan.create) {
    const made = await stripe.post<{ id?: string; secret?: string }>("/v1/webhook_endpoints", { url, enabled_events: [...EVENT_TYPES], api_version: API_VERSION, metadata: { studio: STUDIO } });
    if (!made.id || !made.secret) throw new Error("Stripe created the webhook endpoint but returned no signing secret");
    keep({ id: made.id, secret: made.secret });
  }
  // the old ones go only once the new one exists and its secret is stored: there is no moment without an endpoint
  for (const id of plan.remove) await stripe.delete(`/v1/webhook_endpoints/${id}`);
  return plan.create;
}
