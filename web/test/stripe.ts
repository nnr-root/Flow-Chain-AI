import { createServer, type IncomingMessage, type Server } from "node:http";
import { signWebhook } from "@src/billing/stripe";

/*
 * A stand-in Stripe for tests: a local server that answers the handful of API calls the studio makes, keeps
 * customers, prices, sessions, subscriptions, invoices, charges and events in memory, and signs webhooks the
 * way Stripe does. It can also play the customer: `completeCheckout` pays a session, `renew` bills a month,
 * `refund` gives money back — each producing the events Stripe would send. Nothing here reaches Stripe.
 */

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type FakeEvent = { id: string; type: string; created: number; livemode: boolean; data: { object: Obj } };

export type FakeStripe = {
  url: string;
  secretKey: string;
  webhookSecret: string;
  /** What a process needs in its environment to use this Stripe. */
  env: Record<string, string>;
  events: FakeEvent[];
  customers: Map<string, Obj>;
  sessions: Map<string, Obj>;
  /** Every request the studio made, as "METHOD /path". */
  requests: string[];
  /** The account's Customer Portal configurations, and the portal sessions the studio opened. */
  portalConfigurations: Obj[];
  portalSessions: Obj[];
  /** What `npm run stripe:setup` creates: products, every price (archived ones too), webhook endpoints. */
  products: Map<string, Obj>;
  prices: Map<string, Obj>;
  webhookEndpoints: Obj[];
  addPrice(p: { key: string; kind: "plan" | "topup"; priceUsd: number; creditUsd?: number; name?: string; metadata?: Record<string, string> }): string;
  /**
   * The customer pays a Checkout session the studio created. Returns the events Stripe would send. With `later`
   * the session completes with a payment method that confirms afterwards: nothing is paid until `payLater`.
   */
  completeCheckout(sessionId: string, opts?: { later?: boolean }): FakeEvent[];
  payLater(sessionId: string): FakeEvent[];
  charges: Map<string, Obj>;
  /** A month goes by: the subscription's next invoice is paid. */
  renew(subscriptionId: string): FakeEvent[];
  updateSubscription(subscriptionId: string, change: Obj): FakeEvent[];
  cancelSubscription(subscriptionId: string): FakeEvent[];
  refund(chargeId: string, usd: number): FakeEvent[];
  dispute(chargeId: string, usd: number): FakeEvent[];
  /** An event of a type the studio does not act on, or a hand-made one. */
  emit(type: string, object: Obj): FakeEvent;
  /** The body and signature header Stripe would send for an event. */
  signed(event: FakeEvent, opts?: { secret?: string; at?: number }): { body: string; signature: string };
  /** Where `completeCheckout` through the browser page delivers webhooks (the studio's webhook route). */
  deliverTo?: string;
  stop(): Promise<void>;
};

let seq = 0;
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const cents = (usd: number) => Math.round(usd * 100);

/** `a[b][0]=x&…` into nested objects (what the studio's form posts look like). */
function parseForm(text: string): Obj {
  const out: Obj = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const path = rawKey.replace(/\]/g, "").split("[");
    let at = out;
    path.forEach((part, i) => {
      if (i === path.length - 1) at[part] = value;
      else at = at[part] ??= {};
    });
  }
  return out;
}

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((done) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString()));
    req.on("end", () => done(text));
  });

/** `port`, the keys and `deliverTo` are given when the stand-in runs as a process of its own (the browser test). */
export async function startStripe(opts: { port?: number; secretKey?: string; webhookSecret?: string; deliverTo?: string } = {}): Promise<FakeStripe> {
  const secretKey = opts.secretKey ?? `sk_test_${Math.random().toString(36).slice(2)}`;
  const webhookSecret = opts.webhookSecret ?? `whsec_${Math.random().toString(36).slice(2)}`;
  const customers = new Map<string, Obj>();
  const byIdempotencyKey = new Map<string, Obj>();
  const prices = new Map<string, Obj>();
  const sessions = new Map<string, Obj>();
  const subscriptions = new Map<string, Obj>();
  const invoices = new Map<string, Obj>();
  const charges = new Map<string, Obj>();
  const intents = new Map<string, Obj>();
  const events: FakeEvent[] = [];
  const requests: string[] = [];
  const products = new Map<string, Obj>();
  const now = () => Math.floor(Date.now() / 1000);

  const emit = (type: string, object: Obj): FakeEvent => {
    // a snapshot, as Stripe's events are: the object as it was then
    const event = { id: id("evt"), type, created: now(), livemode: false, data: { object: JSON.parse(JSON.stringify(object)) as Obj } };
    events.push(event);
    return event;
  };
  const charge = (customer: string, usd: number): Obj => {
    const c = { id: id("ch"), object: "charge", customer, amount: cents(usd), amount_refunded: 0, disputed: false, receipt_url: `https://stripe.test/receipts/${id("rcpt")}` };
    charges.set(c.id, c);
    return c;
  };
  const invoice = (sub: Obj, reason: string): Obj => {
    const price = prices.get(sub.items.data[0].price.id)!;
    const paid = charge(sub.customer, price.unit_amount / 100);
    const inv = {
      id: id("in"), object: "invoice", status: "paid", billing_reason: reason, customer: sub.customer, subscription: sub.id, amount_paid: price.unit_amount, currency: "usd",
      charge: paid.id, hosted_invoice_url: `https://stripe.test/invoices/${id("inv")}`, lines: { data: [{ price, quantity: 1, proration: false }] },
    };
    invoices.set(inv.id, inv);
    return inv;
  };

  const api: Omit<FakeStripe, "url" | "env" | "stop"> = {
    secretKey, webhookSecret, events, customers, sessions, requests, charges, portalConfigurations: [], portalSessions: [], products, prices, webhookEndpoints: [], deliverTo: opts.deliverTo,
    addPrice(p) {
      const priceId = id("price");
      prices.set(priceId, {
        id: priceId, object: "price", active: true, currency: "usd", unit_amount: cents(p.priceUsd), recurring: p.kind === "plan" ? { interval: "month" } : null,
        metadata: { studio: "flowchain", key: p.key, ...(p.kind === "plan" ? { plan: p.key } : {}), ...(p.creditUsd === undefined ? {} : { credit_usd: String(p.creditUsd) }), ...p.metadata },
        product: { id: id("prod"), name: p.name ?? p.key, active: true },
      });
      return priceId;
    },
    payLater(sessionId) {
      const session = sessions.get(sessionId)!;
      const paid = charge(session.customer, session.amount_total / 100);
      const intent = { id: id("pi"), object: "payment_intent", latest_charge: paid.id };
      intents.set(intent.id, intent);
      session.payment_intent = intent.id;
      session.payment_status = "paid";
      return [emit("checkout.session.async_payment_succeeded", session)];
    },
    completeCheckout(sessionId, opts = {}) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`no session ${sessionId}`);
      const price = prices.get(session.line_items.data[0].price.id)!;
      session.status = "complete";
      session.amount_total = price.unit_amount * session.line_items.data[0].quantity;
      if (session.mode === "payment" && opts.later) return [emit("checkout.session.completed", session)];
      session.payment_status = "paid";
      if (session.mode === "payment") {
        const paid = charge(session.customer, session.amount_total / 100);
        const intent = { id: id("pi"), object: "payment_intent", latest_charge: paid.id };
        intents.set(intent.id, intent);
        session.payment_intent = intent.id;
        return [emit("checkout.session.completed", session)];
      }
      const sub: Obj = {
        id: id("sub"), object: "subscription", customer: session.customer, status: "active", cancel_at_period_end: false,
        current_period_end: now() + 30 * 86_400, items: { data: [{ price }] },
      };
      subscriptions.set(sub.id, sub);
      session.subscription = sub.id;
      return [emit("customer.subscription.created", sub), emit("invoice.paid", invoice(sub, "subscription_create")), emit("checkout.session.completed", session)];
    },
    renew(subscriptionId) {
      const sub = subscriptions.get(subscriptionId)!;
      sub.current_period_end += 30 * 86_400;
      return [emit("invoice.paid", invoice(sub, "subscription_cycle")), emit("customer.subscription.updated", sub)];
    },
    updateSubscription(subscriptionId, change) {
      const sub = subscriptions.get(subscriptionId)!;
      Object.assign(sub, change);
      return [emit("customer.subscription.updated", sub)];
    },
    cancelSubscription(subscriptionId) {
      const sub = subscriptions.get(subscriptionId)!;
      sub.status = "canceled";
      return [emit("customer.subscription.deleted", sub)];
    },
    refund(chargeId, usd) {
      const c = charges.get(chargeId)!;
      c.amount_refunded = Math.min(c.amount, c.amount_refunded + cents(usd));
      return [emit("charge.refunded", c)];
    },
    dispute(chargeId, usd) {
      charges.get(chargeId)!.disputed = true;
      return [emit("charge.dispute.created", { id: id("dp"), object: "dispute", charge: chargeId, amount: cents(usd) })];
    },
    emit,
    signed(event, opts = {}) {
      const body = JSON.stringify(event);
      return { body, signature: signWebhook(body, opts.secret ?? webhookSecret, opts.at) };
    },
  };

  const expandSession = (session: Obj, expand: string[]): Obj => ({
    ...session,
    payment_intent: expand.includes("payment_intent") && session.payment_intent ? intents.get(session.payment_intent) : session.payment_intent,
    line_items: expand.some((e) => e.startsWith("line_items")) ? session.line_items : undefined,
  });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stripe.test");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const missing = (what: string) => send(404, { error: { code: "resource_missing", message: `No such ${what}` } });
    const text = await read(req);
    const stripe = api as FakeStripe;

    // the page a customer is sent to: here it pays at once, tells the studio, and sends the browser back
    const pay = /^\/pay\/(cs_[^/]+)$/.exec(url.pathname);
    if (pay) {
      const session = sessions.get(pay[1]);
      if (!session) return missing("session");
      for (const event of stripe.completeCheckout(pay[1])) {
        if (!stripe.deliverTo) continue;
        const { body, signature } = stripe.signed(event);
        await fetch(stripe.deliverTo, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body }).catch(() => {});
      }
      res.writeHead(303, { location: session.success_url });
      return res.end();
    }
    if (url.pathname.startsWith("/portal/")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<h1>Stand-in customer portal</h1>");
    }

    requests.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${secretKey}`) return send(401, { error: { message: "Invalid API Key provided" } });
    if (!req.headers["stripe-version"]) return send(400, { error: { message: "the studio must name the API version it speaks" } });
    const form = req.method === "POST" ? parseForm(text) : {};
    const expand = url.searchParams.getAll("expand[0]").concat(url.searchParams.getAll("expand[1]"));
    const one = (pattern: RegExp) => pattern.exec(url.pathname)?.[1];

    if (req.method === "POST" && url.pathname === "/v1/customers") {
      const key = String(req.headers["idempotency-key"] ?? "");
      if (key && byIdempotencyKey.has(key)) return send(200, byIdempotencyKey.get(key));
      const customer = { id: id("cus"), object: "customer", email: form.email ?? null, metadata: form.metadata ?? {} };
      customers.set(customer.id, customer);
      if (key) byIdempotencyKey.set(key, customer);
      return send(200, customer);
    }
    let found = one(/^\/v1\/customers\/([^/]+)$/);
    if (found) return customers.has(found) ? send(200, customers.get(found)) : missing("customer");

    if (req.method === "GET" && url.pathname === "/v1/prices") {
      return send(200, { object: "list", has_more: false, data: [...prices.values()].filter((p) => p.active) });
    }
    if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const price = prices.get(form.line_items?.[0]?.price);
      if (!price) return send(400, { error: { message: "No such price" } });
      if (!customers.has(form.customer)) return send(400, { error: { message: "No such customer" } });
      const sessionId = id("cs");
      const session = {
        id: sessionId, object: "checkout.session", mode: form.mode, customer: form.customer, client_reference_id: form.client_reference_id ?? null,
        status: "open", payment_status: "unpaid", amount_total: null, currency: "usd", payment_intent: null, subscription: null,
        success_url: form.success_url, cancel_url: form.cancel_url, url: `${base}/pay/${sessionId}`,
        line_items: { data: [{ price, quantity: Number(form.line_items[0].quantity ?? 1) }] },
      };
      sessions.set(sessionId, session);
      return send(200, { ...session, line_items: undefined });
    }
    found = one(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (found) return sessions.has(found) ? send(200, expandSession(sessions.get(found)!, expand)) : missing("session");

    if (req.method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
      if (!customers.has(form.customer)) return send(400, { error: { message: "No such customer" } });
      const session = { id: id("bps"), object: "billing_portal.session", customer: form.customer, return_url: form.return_url, configuration: form.configuration ?? null, url: `${base}/portal/${form.customer}` };
      stripe.portalSessions.push(session);
      return send(200, session);
    }
    if (req.method === "GET" && url.pathname === "/v1/billing_portal/configurations") {
      return send(200, { object: "list", has_more: false, data: stripe.portalConfigurations });
    }

    // what setup does: products, prices, the portal's configuration, the webhook endpoint
    const list = (form: unknown): string[] => Object.values((form ?? {}) as Record<string, string>);
    if (req.method === "GET" && url.pathname === "/v1/products") {
      return send(200, { object: "list", has_more: false, data: [...products.values()].filter((p) => p.active) });
    }
    if (req.method === "POST" && url.pathname === "/v1/products") {
      const product = { id: id("prod"), object: "product", active: true, name: form.name, metadata: form.metadata ?? {} };
      products.set(product.id, product);
      return send(200, product);
    }
    found = one(/^\/v1\/products\/([^/]+)$/);
    if (found && req.method === "POST") {
      const product = products.get(found);
      if (!product) return missing("product");
      if (form.name !== undefined) product.name = form.name;
      if (form.active !== undefined) product.active = form.active === "true";
      return send(200, product);
    }
    if (req.method === "POST" && url.pathname === "/v1/prices") {
      const product = products.get(form.product);
      if (!product) return missing("product");
      const price = {
        id: id("price"), object: "price", active: true, currency: form.currency, unit_amount: Number(form.unit_amount),
        recurring: form.recurring ? { interval: form.recurring.interval } : null, metadata: form.metadata ?? {}, product,
      };
      prices.set(price.id, price);
      return send(200, price);
    }
    found = one(/^\/v1\/prices\/([^/]+)$/);
    if (found && req.method === "POST") {
      const price = prices.get(found);
      if (!price) return missing("price");
      if (form.active !== undefined) price.active = form.active === "true";
      return send(200, price);
    }
    found = one(/^\/v1\/billing_portal\/configurations\/([^/]+)$/);
    if (req.method === "POST" && (found || url.pathname === "/v1/billing_portal/configurations")) {
      const existing = stripe.portalConfigurations.find((c) => c.id === found);
      if (found && !existing) return missing("configuration");
      const configuration = Object.assign(existing ?? { id: id("bpc"), object: "billing_portal.configuration", active: true }, { features: form.features, metadata: form.metadata ?? {}, business_profile: form.business_profile });
      if (!existing) stripe.portalConfigurations.push(configuration);
      return send(200, configuration);
    }
    if (req.method === "GET" && url.pathname === "/v1/webhook_endpoints") {
      // without their secrets: Stripe says a secret once, when the endpoint is made
      return send(200, { object: "list", has_more: false, data: stripe.webhookEndpoints.map(({ secret: _secret, ...rest }) => rest) });
    }
    if (req.method === "POST" && url.pathname === "/v1/webhook_endpoints") {
      const endpoint = { id: id("we"), object: "webhook_endpoint", url: form.url, status: "enabled", enabled_events: list(form.enabled_events), api_version: form.api_version ?? null, secret: `whsec_${id("s").replace(/_/g, "")}` };
      stripe.webhookEndpoints.push(endpoint);
      return send(200, endpoint);
    }
    found = one(/^\/v1\/webhook_endpoints\/([^/]+)$/);
    if (found && req.method === "DELETE") {
      const at = stripe.webhookEndpoints.findIndex((e) => e.id === found);
      if (at < 0) return missing("webhook endpoint");
      stripe.webhookEndpoints.splice(at, 1);
      return send(200, { id: found, deleted: true });
    }
    for (const [pattern, store, what] of [
      [/^\/v1\/charges\/([^/]+)$/, charges, "charge"], [/^\/v1\/invoices\/([^/]+)$/, invoices, "invoice"], [/^\/v1\/subscriptions\/([^/]+)$/, subscriptions, "subscription"],
    ] as const) {
      found = one(pattern);
      if (found) return store.has(found) ? send(200, store.get(found)) : missing(what);
    }
    found = one(/^\/v1\/events\/([^/]+)$/);
    if (found) {
      const event = events.find((e) => e.id === found);
      return event ? send(200, event) : missing("event");
    }
    if (req.method === "GET" && url.pathname === "/v1/events") {
      const since = Number(url.searchParams.get("created[gte]") ?? 0);
      // newest first, as Stripe lists them
      return send(200, { object: "list", has_more: false, data: events.filter((e) => e.created >= since).reverse() });
    }
    return send(404, { error: { message: `the stand-in Stripe has no ${req.method} ${url.pathname}` } });
  });

  await new Promise<void>((done) => server.listen(opts.port ?? 0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return Object.assign(api as FakeStripe, {
    url: base,
    env: { STRIPE_SECRET_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_API_BASE: base },
    stop: () => new Promise<void>((done) => server.close(() => done())),
  });
}
