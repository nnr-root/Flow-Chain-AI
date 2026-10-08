import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signWebhook } from "@src/billing/stripe";
import { GET as accountRoute } from "@/app/api/account/route";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { POST as portal } from "@/app/api/billing/portal/route";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { forgetCatalogue } from "@/server/billing/catalogue";
import { closeQueue } from "@/server/jobs/queue";
import { JOB_OPTIONS, QUEUES } from "@/server/jobs/redis";
import { localSupabase, newUser, serviceClient, type TestUser } from "../../test/helpers/supabase";
import { request, until, useStudio } from "./helpers";
import { hasRedisServer, startRedis, startWorkerProcess, type TestRedis, type TestWorker } from "./redis";
import { type FakeEvent, type FakeStripe, startStripe } from "./stripe";
import { as, cookiesOf, withAccounts } from "./tenant";

/*
 * Payments end to end, against the stand-in Stripe, the local Supabase stack, a throwaway Redis and the real
 * worker in its own process. Skipped without the stack or `redis-server`.
 */
const supa = localSupabase();
const studio = useStudio();
let redis: TestRedis;
let admin: Redis;
let stripe: FakeStripe;
let workers: TestWorker[] = [];

beforeAll(async () => {
  if (!supa || !hasRedisServer()) return;
  redis = await startRedis();
  admin = new Redis(redis.url, { maxRetriesPerRequest: null });
  admin.on("error", () => {});
});
afterAll(async () => {
  admin?.disconnect();
  await redis?.stop();
});
afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  workers = [];
  await closeQueue();
  await stripe?.stop();
});

describe.skipIf(!supa || !hasRedisServer())("payments", () => {
  const s = supa!;
  const db = () => serviceClient(s);
  let a: TestUser;
  let b: TestUser;
  let aCookie: string;
  let bCookie: string;
  let topup: string;
  let starter: string;

  const account = async (u: TestUser) => {
    const { data } = await db().from("users").select("balance_usd,plan_credit_usd,stripe_customer_id").eq("id", u.id).single();
    return { balance: Number(data!.balance_usd), plan: Number(data!.plan_credit_usd), customer: data!.stripe_customer_id as string | null };
  };
  const worker = async (env: Record<string, string> = {}): Promise<TestWorker> => {
    const w = startWorkerProcess({
      REDIS_URL: redis.url, FLOWCHAIN_ROOT: studio.root, RUNS_DIR: studio.runs, FLOWCHAIN_CLI: process.env.FLOWCHAIN_CLI!,
      SUPABASE_URL: s.url, SUPABASE_ANON_KEY: s.anonKey, SUPABASE_SERVICE_ROLE_KEY: s.serviceKey,
      WORKER_RECONCILE_KNOWN_USERS_ONLY: "1", ...stripe.env, ...env,
    });
    workers.push(w);
    await until(() => w.output().includes("ready") || w.child.exitCode !== null);
    return w;
  };
  /** Stripe calling the studio, as it would. */
  const deliver = (event: FakeEvent, opts: { secret?: string; at?: number; body?: string } = {}) => {
    const { body, signature } = stripe.signed(event, opts);
    return webhook(new Request("http://127.0.0.1:3131/api/stripe/webhook", {
      method: "POST", body: opts.body ?? body, headers: { host: "127.0.0.1:3131", "content-type": "application/json", "stripe-signature": signature },
    }), undefined);
  };
  const outcome = async (res: Response) => ((await res.json()) as { outcome?: string; error?: { code: string } });
  /** The signed-in user goes to buy: the session Stripe was asked to open. */
  const buy = async (cookie: string, priceId: string) => {
    const res = await checkout(as(cookie, "/api/billing/checkout", { json: { priceId } }), undefined);
    const data = (await res.json()) as { url?: string; error?: { code: string; message: string } };
    return { status: res.status, error: data.error, sessionId: data.url?.split("/pay/")[1] };
  };

  beforeEach(async () => {
    stripe = await startStripe();
    topup = stripe.addPrice({ key: "topup-10", kind: "topup", priceUsd: 10, creditUsd: 6, name: "Top-up $10" });
    starter = stripe.addPrice({ key: "starter", kind: "plan", priceUsd: 19, creditUsd: 12, name: "Starter" });
    forgetCatalogue();
    await admin.flushall();
    process.env.REDIS_URL = redis.url;
    withAccounts(s);
    Object.assign(process.env, stripe.env);
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
    [aCookie, bCookie] = await Promise.all([cookiesOf(a), cookiesOf(b)]);
    await Promise.all([mkdir(join(studio.runs, a.id), { recursive: true }), mkdir(join(studio.runs, b.id), { recursive: true })]);
  });

  it("turns a paid top-up into credit, once, for the user who bought it", async () => {
    await worker();
    // the pages learn with the balance that credit can be bought here
    expect(await (await accountRoute(as(aCookie, "/api/account"), undefined)).json()).toEqual({ account: { email: a.email, balanceUsd: 0 }, ledger: [], billing: true });
    const { status, sessionId } = await buy(aCookie, topup);
    expect(status).toBe(200);
    // the customer is the worker's creation, tagged with whose it is, and recorded
    const session = stripe.sessions.get(sessionId!)!;
    expect(stripe.customers.get(session.customer)!.metadata).toEqual({ user_id: a.id, studio: "flowchain" });
    expect((await account(a)).customer).toBe(session.customer);
    expect(session).toMatchObject({ mode: "payment", client_reference_id: a.id, success_url: "http://127.0.0.1:3131/account?paid=1", cancel_url: "http://127.0.0.1:3131/pricing" });
    // nothing is granted for opening a checkout
    expect((await account(a)).balance).toBe(0);

    const [paid] = stripe.completeCheckout(sessionId!);
    const first = await deliver(paid);
    expect([first.status, await outcome(first)]).toEqual([200, { received: true, outcome: "fulfilled" }]);
    expect(await account(a)).toMatchObject({ balance: 6, plan: 0 });
    // Stripe delivers again (it does): nothing more
    expect(await outcome(await deliver(paid))).toEqual({ received: true, outcome: "duplicate" });
    expect((await account(a)).balance).toBe(6);
    expect((await account(b)).balance).toBe(0);
    expect((await a.client.from("payments").select("id,kind,paid_usd,credit_usd,invoice_url")).data).toEqual([
      { id: sessionId, kind: "topup", paid_usd: 10, credit_usd: 6, invoice_url: expect.stringMatching(/^https:\/\/stripe\.test\/receipts\//) },
    ]);
    expect((await b.client.from("payments").select("id")).data).toEqual([]);
  });

  it("grants nothing to a request that Stripe did not sign, or to an event Stripe does not have", async () => {
    await worker();
    const { sessionId } = await buy(aCookie, topup);
    const [paid] = stripe.completeCheckout(sessionId!);
    for (const [what, res] of [
      ["another secret", await deliver(paid, { secret: "whsec_guess" })],
      ["an old signature replayed", await deliver(paid, { at: Math.floor(Date.now() / 1000) - 3600 })],
      ["a body changed after signing", await deliver(paid, { body: JSON.stringify({ ...paid, id: "evt_other" }) })],
    ] as const) {
      expect(res.status, what).toBe(400);
    }
    // nothing larger than a webhook is read, signed or not
    const huge = "x".repeat(1024 * 1024 + 1);
    const tooLarge = await webhook(new Request("http://127.0.0.1:3131/api/stripe/webhook", {
      method: "POST", body: huge, headers: { host: "127.0.0.1:3131", "stripe-signature": signWebhook(huge, stripe.webhookSecret) },
    }), undefined);
    expect([tooLarge.status, ((await tooLarge.json()) as { error: { message: string } }).error.message]).toEqual([400, "the request is too large"]);
    const unsigned = await webhook(new Request("http://127.0.0.1:3131/api/stripe/webhook", { method: "POST", body: JSON.stringify(paid), headers: { host: "127.0.0.1:3131" } }), undefined);
    expect(unsigned.status).toBe(400);
    // an event that carries a good signature but that Stripe itself does not know (a stolen secret, or made up)
    const forged = { ...paid, id: "evt_forged123" };
    expect((await deliver(forged as FakeEvent)).status).toBe(503);
    // and the same id put straight into Redis, past the web altogether
    const quick = new Queue(QUEUES.quick, { connection: admin });
    try {
      await quick.add("stripe-event", { args: [], eventId: "evt_forged123" }, JOB_OPTIONS);
      await quick.add("stripe-event", { args: [], eventId: "../../x" }, JOB_OPTIONS);
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      await quick.close();
    }
    expect((await account(a)).balance).toBe(0);
    expect((await db().from("stripe_events").select("id").eq("user_id", a.id)).data).toEqual([]);
  });

  it("runs a subscription: a paid month grants credit that the next month replaces, whatever order the events come in", async () => {
    await worker();
    await db().rpc("grant_credit", { p_email: a.email, p_amount_usd: 5 });
    const { sessionId } = await buy(aCookie, starter);
    const events = stripe.completeCheckout(sessionId!);
    expect(events.map((e) => e.type)).toEqual(["customer.subscription.created", "invoice.paid", "checkout.session.completed"]);
    // delivered backwards
    for (const event of [...events].reverse()) expect((await deliver(event)).status).toBe(200);
    expect(await account(a)).toMatchObject({ balance: 17, plan: 12 });
    const sub = stripe.sessions.get(sessionId!)!.subscription as string;
    expect((await a.client.from("subscriptions").select("stripe_subscription_id,plan,status,cancel_at_period_end").single()).data)
      .toEqual({ stripe_subscription_id: sub, plan: "starter", status: "active", cancel_at_period_end: false });

    // one plan at a time
    expect(await buy(aCookie, starter)).toMatchObject({ status: 409, error: { code: "already_subscribed" } });
    // a top-up beside it is fine
    expect((await buy(aCookie, topup)).status).toBe(200);

    // a month on: what is left of the 12 goes, a new 12 comes; the 5 that was granted by hand stays
    for (const event of stripe.renew(sub)) expect((await deliver(event)).status).toBe(200);
    expect(await account(a)).toMatchObject({ balance: 17, plan: 12 });
    expect((await a.client.from("ledger").select("kind,amount_usd").order("id")).data).toEqual([
      { kind: "grant", amount_usd: 5 }, { kind: "plan", amount_usd: 12 }, { kind: "expire", amount_usd: -12 }, { kind: "plan", amount_usd: 12 },
    ]);

    // set to end with the month: mirrored, and nothing is taken yet
    for (const event of stripe.updateSubscription(sub, { cancel_at_period_end: true })) await deliver(event);
    expect((await a.client.from("subscriptions").select("status,cancel_at_period_end").single()).data).toEqual({ status: "active", cancel_at_period_end: true });
    expect((await account(a)).plan).toBe(12);
    // the month ends
    for (const event of stripe.cancelSubscription(sub)) expect(await outcome(await deliver(event))).toEqual({ received: true, outcome: "fulfilled" });
    expect(await account(a)).toMatchObject({ balance: 5, plan: 0 });
    expect((await a.client.from("subscriptions").select("status").single()).data).toEqual({ status: "canceled" });
    // and a new plan can be bought again
    expect((await buy(aCookie, starter)).status).toBe(200);
  });

  it("takes credit back for a refund and for a dispute", async () => {
    await worker();
    const { sessionId } = await buy(aCookie, topup);
    await deliver(stripe.completeCheckout(sessionId!)[0]);
    const charge = (await db().from("payments").select("charge_id").eq("id", sessionId!).single()).data!.charge_id as string;
    for (const event of stripe.refund(charge, 5)) expect(await outcome(await deliver(event))).toEqual({ received: true, outcome: "fulfilled" });
    expect((await account(a)).balance).toBe(3);
    // the bank takes the rest back
    for (const event of stripe.dispute(charge, 10)) await deliver(event);
    expect((await account(a)).balance).toBe(0);
    expect((await a.client.from("payments").select("refunded_usd").single()).data).toEqual({ refunded_usd: 10 });
  });

  it("fails loudly on a price that does not say what it grants, and fulfils once the price is put right", async () => {
    const w = await worker();
    const vague = stripe.addPrice({ key: "topup-25", kind: "topup", priceUsd: 25 });
    forgetCatalogue();
    // the catalogue does not offer it; someone bought it all the same (a link made in Stripe's dashboard)
    expect(await buy(aCookie, vague)).toMatchObject({ status: 400 });
    const { sessionId } = await buy(aCookie, topup);
    const session = stripe.sessions.get(sessionId!)!;
    const credit = session.line_items.data[0].price.metadata.credit_usd;
    delete session.line_items.data[0].price.metadata.credit_usd;
    const [paid] = stripe.completeCheckout(sessionId!);
    const failed = await deliver(paid);
    expect([failed.status, (await outcome(failed)).error?.code]).toEqual([503, "billing_unavailable"]);
    expect(w.output()).toContain("does not say how much credit it grants");
    expect((await account(a)).balance).toBe(0);
    // the owner fixes the price in Stripe; Stripe's retry then goes through
    session.line_items.data[0].price.metadata.credit_usd = credit;
    expect(await outcome(await deliver(paid))).toEqual({ received: true, outcome: "fulfilled" });
    expect((await account(a)).balance).toBe(6);
  });

  it("ignores what is not the studio's: other event types, and customers it did not create", async () => {
    await worker();
    expect(await outcome(await deliver(stripe.emit("payment_method.attached", { id: "pm_1" })))).toEqual({ received: true, outcome: "ignored" });
    // a customer made by hand in the same Stripe account pays for the same price
    const { sessionId } = await buy(aCookie, topup);
    const session = stripe.sessions.get(sessionId!)!;
    stripe.customers.set("cus_stranger", { id: "cus_stranger", metadata: {} });
    session.customer = "cus_stranger";
    expect(await outcome(await deliver(stripe.completeCheckout(sessionId!)[0]))).toEqual({ received: true, outcome: "unknown_customer" });
    expect((await account(a)).balance).toBe(0);
  });

  it("fulfils what no webhook brought, when the worker next asks Stripe", async () => {
    // payments happen while nothing is listening
    let w = await worker();
    const first = await buy(aCookie, topup);
    const second = await buy(bCookie, starter);
    await w.stop();
    workers = [];
    stripe.completeCheckout(first.sessionId!);
    stripe.completeCheckout(second.sessionId!);
    expect((await account(a)).balance).toBe(0);

    w = await worker();
    await until(async () => (await account(a)).balance === 6 && (await account(b)).balance === 12, 20_000);
    // (the worker says so once it has been through all of them)
    await until(() => /fulfilled \d+ Stripe event\(s\) no webhook had brought/.test(w.output()), 20_000);
    expect(await account(b)).toMatchObject({ balance: 12, plan: 12 });
    // a webhook that arrives late after all changes nothing
    expect(await outcome(await deliver(stripe.events.find((e) => e.type === "invoice.paid")!))).toEqual({ received: true, outcome: "duplicate" });
    expect((await account(b)).balance).toBe(12);
  });

  it("gives one user one customer, however many tabs ask at once, and opens the portal only for their own", async () => {
    await worker();
    expect((await portal(as(aCookie, "/api/billing/portal", { json: {} }), undefined)).status).toBe(400); // nothing bought yet
    const sessions = await Promise.all([buy(aCookie, topup), buy(aCookie, topup), buy(aCookie, starter)]);
    expect(sessions.map((x) => x.status)).toEqual([200, 200, 200]);
    const customers = new Set(sessions.map((x) => stripe.sessions.get(x.sessionId!)!.customer));
    expect(customers.size).toBe(1);
    expect(stripe.customers.size).toBe(1);

    const opened = await portal(as(aCookie, "/api/billing/portal", { json: {} }), undefined);
    expect(((await opened.json()) as { url: string }).url).toBe(`${stripe.url}/portal/${[...customers][0]}`);
    expect(stripe.portalSessions.at(-1)).toMatchObject({ customer: [...customers][0], return_url: "http://127.0.0.1:3131/account", configuration: null });
    // the configuration that stripe:setup made is the one used, not another in the same account
    stripe.portalConfigurations.push({ id: "bpc_other", metadata: {} }, { id: "bpc_studio", metadata: { studio: "flowchain" } });
    forgetCatalogue();
    await portal(as(aCookie, "/api/billing/portal", { json: {} }), undefined);
    expect(stripe.portalSessions.at(-1)!.configuration).toBe("bpc_studio");
    expect((await portal(as(bCookie, "/api/billing/portal", { json: {} }), undefined)).status).toBe(400);
    expect((await portal(request("/api/billing/portal", { json: {} }), undefined)).status).toBe(401);
    expect((await checkout(request("/api/billing/checkout", { json: { priceId: topup } }), undefined)).status).toBe(401);
    expect(await buy(aCookie, "price_not_ours")).toMatchObject({ status: 400 });
  });

  it("does not exist in a studio that takes no payments", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect((await checkout(as(aCookie, "/api/billing/checkout", { json: { priceId: topup } }), undefined)).status).toBe(404);
    expect((await portal(as(aCookie, "/api/billing/portal", { json: {} }), undefined)).status).toBe(404);
    expect((await deliver(stripe.emit("invoice.paid", { id: "in_1" }))).status).toBe(404);
  });
});
