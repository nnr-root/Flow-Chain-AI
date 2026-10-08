import { z } from "zod";
import { billingOn, LIVE, type PaymentView, type PlanView } from "@/lib/billing";
import { ApiError } from "../http";
import { runner } from "../jobs";
import { siteOrigin } from "../session";
import { currentUser, userDb } from "../tenant";
import { catalogue } from "./catalogue";
import { StripeError, stripeApi } from "@src/billing/stripe";

/* What a signed-in user does about paying: go to Stripe to buy, go to Stripe to manage, and read what they bought. */

const Checkout = z.object({ priceId: z.string().regex(/^price_[A-Za-z0-9_]+$/) });

function stripe() {
  const api = billingOn() ? stripeApi() : null;
  if (!api) throw new ApiError("not_found", "this studio takes no payments");
  return api;
}

const unavailable = (err: unknown): ApiError => {
  console.error("billing:", err instanceof Error ? err.message : String(err));
  return new ApiError("billing_unavailable", "payments are not available right now", "nothing was charged; try again in a moment");
};

/** The user's plan as the database mirrors it from Stripe, or null. */
export async function currentPlan(): Promise<PlanView | null> {
  const { data, error } = await userDb().from("subscriptions").select("plan,status,current_period_end,cancel_at_period_end").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { plan: data.plan as string, status: data.status as string, periodEnd: (data.current_period_end as string | null) ?? null, cancelAtPeriodEnd: data.cancel_at_period_end === true };
}

/**
 * Starts a purchase: a Stripe Checkout page for one of the studio's own prices, for the user's own customer.
 * Returns the page's address. Nothing is granted here: credit follows the payment, through the webhook.
 */
export async function checkout(req: Request, input: unknown): Promise<{ url: string }> {
  const api = stripe();
  const user = currentUser();
  if (!user) throw new ApiError("unauthenticated", "sign in first");
  const { priceId } = Checkout.parse(input);
  // only what the studio sells: a price id from anywhere else is not a thing to open a checkout for
  const item = (await catalogue()).find((i) => i.priceId === priceId);
  if (!item) throw new ApiError("validation", "priceId: that is not something this studio sells");
  if (item.kind === "plan") {
    const plan = await currentPlan();
    if (plan && LIVE.includes(plan.status)) throw new ApiError("already_subscribed", "you already have a plan", "change or cancel it under Manage subscription on your account page");
  }
  // the customer is the worker's to create and to say whose it is
  const customer = await runner().stripeCustomer();
  const origin = siteOrigin(req);
  try {
    const session = await api.post<{ url?: string }>("/v1/checkout/sessions", {
      mode: item.kind === "plan" ? "subscription" : "payment",
      customer,
      client_reference_id: user.id,
      line_items: [{ price: item.priceId, quantity: 1 }],
      success_url: `${origin}/account?paid=1`,
      cancel_url: `${origin}/pricing`,
    });
    if (!session.url) throw new Error("Stripe returned no checkout address");
    return { url: session.url };
  } catch (err) {
    throw err instanceof ApiError ? err : unavailable(err);
  }
}

/** Stripe's own page for changing or cancelling a plan and updating a card, for the user's own customer. */
export async function portal(req: Request): Promise<{ url: string }> {
  const api = stripe();
  const { data, error } = await userDb().from("users").select("stripe_customer_id").single();
  if (error) throw new ApiError("unauthenticated", "sign in first");
  const customer = data?.stripe_customer_id as string | null;
  if (!customer) throw new ApiError("validation", "there is nothing to manage yet: you have not bought anything");
  try {
    const session = await api.post<{ url?: string }>("/v1/billing_portal/sessions", { customer, return_url: `${siteOrigin(req)}/account` });
    if (!session.url) throw new Error("Stripe returned no portal address");
    return { url: session.url };
  } catch (err) {
    throw err instanceof StripeError || !(err instanceof ApiError) ? unavailable(err) : err;
  }
}

export type BillingView = { plan: PlanView | null; planCreditUsd: number; payments: PaymentView[] };

/** What the account page shows about paying: row-level security makes every query here "mine". */
export async function billingView(): Promise<BillingView> {
  const [plan, me, paid] = await Promise.all([
    currentPlan(),
    userDb().from("users").select("plan_credit_usd").single(),
    userDb().from("payments").select("id,kind,plan,paid_usd,credit_usd,refunded_usd,invoice_url,created_at").order("created_at", { ascending: false }).limit(50),
  ]);
  if (me.error || paid.error) throw new Error((me.error ?? paid.error)!.message);
  return {
    plan,
    planCreditUsd: Number(me.data.plan_credit_usd),
    payments: (paid.data ?? []).map((p) => ({
      id: p.id as string, kind: p.kind as "plan" | "topup", plan: (p.plan as string | null) ?? null, paidUsd: Number(p.paid_usd), creditUsd: Number(p.credit_usd),
      refundedUsd: Number(p.refunded_usd), invoiceUrl: (p.invoice_url as string | null) ?? null, at: p.created_at as string,
    })),
  };
}
