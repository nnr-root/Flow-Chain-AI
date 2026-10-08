import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { creditOf, EVENT_TYPES, pathId, type StripeApi, StripeError, stripeApi, usdOf } from "@src/billing/stripe";
import { UUID } from "../server/tenant";

/*
 * The worker's side of billing: it alone turns a Stripe payment into credit. It never takes anyone's word for
 * what an event says — not the web's, not Redis's: it asks Stripe for the event by its id, asks again for the
 * objects the event is about as they are now, and hands the result to one SQL function that records the
 * event's id with its effect, so nothing is fulfilled twice.
 */

type Obj = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
/** An id, whether the field holds it or the whole object. */
const idOf = (value: unknown): string | undefined => str(value) ?? str((value as Obj | null)?.id);
const iso = (seconds: unknown): string | null => (typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null);

export type Billing = {
  /** The user's Stripe customer, created when they have none. */
  customer(userId: string): Promise<string>;
  /** Fulfils one event; returns what was done ("fulfilled", "duplicate", "ignored", …). Throws when it could not be. */
  fulfil(eventId: string): Promise<string>;
  /** Fulfils the events of the last `hours` that were never recorded; returns how many. */
  catchUp(hours?: number): Promise<number>;
};

/** A fulfilment that cannot be done as things are: the event stays unrecorded, so a retry can succeed once they are put right. */
class Unfulfillable extends Error {}

export function billing(log: (message: string) => void): Billing | null {
  const stripe = stripeApi();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!stripe || !url || !key) return null;
  const db: SupabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return createBilling(stripe, db, log);
}

export function createBilling(stripe: StripeApi, db: SupabaseClient, log: (message: string) => void): Billing {
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return String(data);
  };

  /** Whose customer this is: the user id the worker itself wrote on it when it created it. Nobody's otherwise. */
  const userOf = async (customer: unknown): Promise<string | undefined> => {
    const id = idOf(customer);
    if (!id) return undefined;
    const c = await stripe.get<Obj>(`/v1/customers/${pathId(id)}`);
    const user = str((c.metadata as Obj | undefined)?.user_id);
    return user && UUID.test(user) ? user : undefined;
  };

  /** What a price grants. A price that is not the studio's, or names no credit, cannot be fulfilled. */
  const grantOf = (price: unknown): { priceId: string; plan: string; creditUsd: number } => {
    const p = (price ?? {}) as Obj;
    const meta = (p.metadata ?? {}) as Obj;
    const credit = creditOf(meta);
    if (meta.studio !== "flowchain" || credit === null) {
      throw new Unfulfillable(`the price ${String(p.id)} does not say how much credit it grants (metadata studio=flowchain, credit_usd)`);
    }
    return { priceId: String(p.id), plan: str(meta.plan) ?? str(meta.key) ?? "plan", creditUsd: credit };
  };

  /**
   * What was paid, in dollars. Credit is sold at a mark-up, so a payment never grants more than it was: a price
   * in Stripe that says otherwise (a mistake, or someone with the account's key) is not fulfilled. Nor is a
   * payment in another currency, whose amount would be read as dollars.
   */
  const paidFor = (what: string, currency: unknown, cents: unknown, creditUsd: number): number => {
    if (currency !== "usd") throw new Unfulfillable(`${what} was paid in ${String(currency)}, not in USD`);
    const paid = usdOf(cents);
    if (!(paid >= creditUsd)) throw new Unfulfillable(`${what} would grant $${creditUsd} of credit for $${paid} paid`);
    return paid;
  };

  /** How much of a charge has left the studio's hands: refunded, or all of it while a dispute holds it. */
  const takenBack = (charge: Obj): number => (charge.disputed === true ? usdOf(charge.amount) || 0 : usdOf(charge.amount_refunded) || 0);

  /**
   * A payment can be refunded before it is fulfilled (its fulfilment was failing meanwhile). The refund's own
   * event found no payment then; so right after granting, the charge is looked at as it is now.
   */
  const settleRefunds = async (eventId: string, chargeId: string | undefined, charge?: Obj): Promise<void> => {
    if (!chargeId) return;
    const now = charge ?? (await stripe.get<Obj>(`/v1/charges/${pathId(chargeId)}`));
    const refunded = takenBack(now);
    if (refunded > 0) await call("refund_payment", { p_event_id: `${eventId}_refunded`, p_charge_id: chargeId, p_refunded_usd: refunded });
  };

  /** Events seen that could not take effect yet. In memory only: after a restart each is said once more. */
  const waiting = new Set<string>();

  const ignore = async (eventId: string, type: string, why: string): Promise<string> => {
    await call("claim_stripe_event", { p_event_id: eventId, p_type: type, p_user_id: null, p_outcome: why });
    return why;
  };

  async function topup(eventId: string, type: string, sessionId: string): Promise<string> {
    const session = await stripe.get<Obj>(`/v1/checkout/sessions/${pathId(sessionId)}`, { expand: ["line_items.data.price", "payment_intent"] });
    // a subscription's Checkout is fulfilled by its invoice; a session that is not paid yet, by a later event
    if (session.mode !== "payment") return ignore(eventId, type, "ignored");
    if (session.payment_status !== "paid") return "not_paid";
    const user = await userOf(session.customer);
    if (!user) return ignore(eventId, type, "unknown_customer");
    const lines = ((session.line_items as Obj | undefined)?.data as Obj[] | undefined) ?? [];
    if (lines.length !== 1) throw new Unfulfillable(`the session ${sessionId} has ${lines.length} line items; the studio sells one thing at a time`);
    const grant = grantOf(lines[0].price);
    const quantity = typeof lines[0].quantity === "number" ? lines[0].quantity : 1;
    const credit = Math.round(grant.creditUsd * quantity * 10_000) / 10_000;
    const paid = paidFor(`the session ${sessionId}`, session.currency, session.amount_total, credit);
    const chargeId = idOf((session.payment_intent as Obj | undefined)?.latest_charge);
    const charge = chargeId ? await stripe.get<Obj>(`/v1/charges/${pathId(chargeId)}`) : undefined;
    const outcome = await call("fulfil_topup", {
      p_event_id: eventId, p_user_id: user, p_payment_id: sessionId, p_paid_usd: paid,
      p_credit_usd: credit, p_charge_id: chargeId ?? null, p_invoice_url: str(charge?.receipt_url) ?? null,
    });
    if (outcome === "fulfilled") await settleRefunds(eventId, chargeId, charge);
    return outcome;
  }

  async function planInvoice(eventId: string, type: string, invoiceId: string): Promise<string> {
    const invoice = await stripe.get<Obj>(`/v1/invoices/${pathId(invoiceId)}`, { expand: ["lines.data.price"] });
    // Credit follows a month that was paid for: the first, or a renewal. A proration or a manual invoice grants nothing.
    if (invoice.status !== "paid") return "not_paid";
    if (invoice.billing_reason !== "subscription_create" && invoice.billing_reason !== "subscription_cycle") return ignore(eventId, type, "ignored");
    const subscriptionId = idOf(invoice.subscription);
    if (!subscriptionId) return ignore(eventId, type, "ignored");
    const user = await userOf(invoice.customer);
    if (!user) return ignore(eventId, type, "unknown_customer");
    // the month's own line: what a change of plan settles in between (a proration) is not a month
    const lines = (((invoice.lines as Obj | undefined)?.data as Obj[] | undefined) ?? []).filter((l) => l.proration !== true);
    if (lines.length !== 1) throw new Unfulfillable(`the invoice ${invoiceId} has ${lines.length} lines for a month; the studio expects one`);
    const grant = grantOf(lines[0].price);
    const paid = paidFor(`the invoice ${invoiceId}`, invoice.currency, invoice.amount_paid, grant.creditUsd);
    const subscription = await stripe.get<Obj>(`/v1/subscriptions/${pathId(subscriptionId)}`);
    const chargeId = idOf(invoice.charge);
    const outcome = await call("fulfil_plan_invoice", {
      p_event_id: eventId, p_user_id: user, p_invoice_id: invoiceId, p_subscription_id: subscriptionId, p_plan: grant.plan, p_price_id: grant.priceId,
      p_paid_usd: paid, p_credit_usd: grant.creditUsd, p_period_end: iso(subscription.current_period_end),
      p_charge_id: chargeId ?? null, p_invoice_url: str(invoice.hosted_invoice_url) ?? null,
    });
    if (outcome === "fulfilled" || outcome === "second_subscription") {
      await settleRefunds(eventId, chargeId);
      // The subscription as it is now, not as the invoice knew it: a month fulfilled late, after its subscription
      // was ended, must not leave the user with a plan that no later event will ever end.
      if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
        await call("end_subscription", { p_event_id: `${eventId}_ended`, p_user_id: user, p_subscription_id: subscriptionId });
      }
    }
    return outcome;
  }

  async function subscription(eventId: string, type: string, subscriptionId: string): Promise<string> {
    // as it is now, not as the event saw it: Stripe does not promise to deliver in order
    const sub = await stripe.get<Obj>(`/v1/subscriptions/${pathId(subscriptionId)}`, { expand: ["items.data.price"] });
    const user = await userOf(sub.customer);
    if (!user) return ignore(eventId, type, "unknown_customer");
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
      return call("end_subscription", { p_event_id: eventId, p_user_id: user, p_subscription_id: subscriptionId });
    }
    const price = (((sub.items as Obj | undefined)?.data as Obj[] | undefined)?.[0]?.price ?? {}) as Obj;
    const meta = (price.metadata ?? {}) as Obj;
    return call("sync_subscription", {
      p_event_id: eventId, p_user_id: user, p_subscription_id: subscriptionId, p_plan: str(meta.plan) ?? str(meta.key) ?? "plan",
      p_price_id: str(price.id) ?? "", p_status: str(sub.status) ?? "unknown", p_period_end: iso(sub.current_period_end),
      p_cancel_at_period_end: sub.cancel_at_period_end === true,
    });
  }

  async function refund(eventId: string, chargeId: string, disputedCents?: unknown): Promise<string> {
    const charge = await stripe.get<Obj>(`/v1/charges/${pathId(chargeId)}`);
    // what has left the studio's hands for this charge so far: refunded, and held by a dispute on top of that
    // (the database never takes back more than was paid)
    const refunded = Math.max(takenBack(charge), (usdOf(charge.amount_refunded) || 0) + (disputedCents === undefined ? 0 : usdOf(disputedCents) || 0));
    return call("refund_payment", { p_event_id: eventId, p_charge_id: chargeId, p_refunded_usd: refunded });
  }

  async function fulfil(eventId: string): Promise<string> {
    if (!/^evt_[A-Za-z0-9_]+$/.test(eventId)) throw new Error("not a Stripe event id");
    // The event as Stripe has it. An id Stripe does not know — one somebody made up — ends here.
    const event = await stripe.get<Obj>(`/v1/events/${pathId(eventId)}`);
    if (event.id !== eventId) throw new Error("Stripe answered with another event");
    // a test-mode event must never become credit in a live studio, nor the other way round
    if ((event.livemode === true) !== stripe.live) throw new Error(`the event is ${event.livemode ? "live" : "test"} and the studio's key is not`);
    const type = String(event.type);
    const object = (((event.data ?? {}) as Obj).object ?? {}) as Obj;
    const objectId = str(object.id);
    if (!objectId) throw new Error("the event names no object");
    let outcome: string;
    if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") outcome = await topup(eventId, type, objectId);
    else if (type === "invoice.paid") outcome = await planInvoice(eventId, type, objectId);
    else if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") outcome = await subscription(eventId, type, objectId);
    else if (type === "charge.refunded") outcome = await refund(eventId, objectId);
    else if (type === "charge.dispute.created") {
      const charge = idOf(object.charge);
      if (!charge) throw new Error("the dispute names no charge");
      outcome = await refund(eventId, charge, object.amount);
    } else outcome = await ignore(eventId, type, "ignored");
    // An event that waits for something (a payment not paid yet, a refund whose payment is not recorded yet) is
    // not recorded, and the catch-up offers it again every hour: said once, not every hour.
    const waits = outcome === "not_paid" || outcome === "unknown_payment";
    if (outcome !== "duplicate" && !(waits && waiting.has(eventId))) log(`worker: Stripe event ${eventId} (${type}): ${outcome}`);
    if (waits) waiting.add(eventId);
    else waiting.delete(eventId);
    return outcome;
  }

  async function customer(userId: string): Promise<string> {
    if (!UUID.test(userId)) throw new Error("not a user id");
    const { data, error } = await db.from("users").select("email,stripe_customer_id").eq("id", userId).maybeSingle();
    if (error) throw new Error(`reading the user: ${error.message}`);
    if (!data) throw new Error("no such user");
    if (data.stripe_customer_id) return data.stripe_customer_id as string;
    // The same key for the same request, always: two at once, or a retry, get the one customer. (Stripe refuses
    // a key that comes back with other contents, so what could change — the address — is part of the key.)
    const email = (data.email as string) || undefined;
    const key = `flowchain-customer-${userId}-${createHash("sha256").update(email ?? "").digest("hex").slice(0, 12)}`;
    const made = await stripe.post<Obj>("/v1/customers", { email, metadata: { user_id: userId, studio: "flowchain" } }, key);
    const id = str(made.id);
    if (!id) throw new Error("Stripe created no customer");
    const linked = await db.rpc("link_stripe_customer", { p_user_id: userId, p_customer_id: id });
    if (linked.error) throw new Error(`link_stripe_customer: ${linked.error.message}`);
    log(`worker: created the Stripe customer of ${userId}`);
    return id;
  }

  async function catchUp(hours = 72): Promise<number> {
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const MAX = 1000;
    const events = await stripe.list<{ id: string }>("/v1/events", { created: { gte: since }, types: [...EVENT_TYPES] }, MAX);
    if (events.length === 0) return 0;
    // Stripe lists the newest first: what a cut leaves out is the oldest, the ones about to be out of reach
    if (events.length >= MAX) log(`worker: more than ${MAX} Stripe events in the last ${hours} hours; the oldest were not looked at`);
    const ids = events.map((e) => e.id);
    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from("stripe_events").select("id").in("id", ids.slice(i, i + 200));
      if (error) throw new Error(`reading recorded events: ${error.message}`);
      for (const row of data ?? []) known.add(row.id as string);
    }
    let done = 0;
    // oldest first, as they happened
    for (const id of ids.reverse()) {
      if (known.has(id)) continue;
      try {
        const outcome = await fulfil(id);
        if (outcome !== "duplicate" && outcome !== "not_paid" && outcome !== "unknown_payment") done++;
      } catch (err) {
        log(`worker: could not fulfil Stripe event ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return done;
  }

  return {
    customer,
    catchUp,
    fulfil: async (eventId) => {
      try {
        return await fulfil(eventId);
      } catch (err) {
        const why = err instanceof StripeError && err.status === 404 ? "Stripe does not know that event" : err instanceof Error ? err.message : String(err);
        log(`worker: could not fulfil Stripe event ${eventId}: ${why}`);
        throw new Error(why);
      }
    },
  };
}
