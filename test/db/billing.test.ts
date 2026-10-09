import { beforeEach, describe, expect, it } from "vitest";
import { freshRunId, localDb, newUser, serviceClient, type TestUser } from "../helpers/db.js";

/*
 * Paying for credit, in the database alone (the local Postgres container): the two kinds of credit, what a Stripe
 * event may do and may not do twice, and that none of it is a user's to call. Other test files use the same
 * database at the same time: every test makes its own users, runs and event ids.
 */
const supa = localDb();
let n = 0;
const unique = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!supa)("billing in the database", () => {
  const s = supa!;
  const db = () => serviceClient(s);
  let a: TestUser;
  let b: TestUser;

  const account = async (u: TestUser) => {
    const { data } = await db().from("users").select("balance_usd,plan_credit_usd,plan_period").eq("id", u.id).single();
    return { balance: Number(data!.balance_usd), plan: Number(data!.plan_credit_usd), period: data!.plan_period as number };
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db().rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data as string;
  };
  const topup = (u: TestUser, credit: number, opts: { event?: string; payment?: string; paid?: number; charge?: string } = {}) =>
    rpc("fulfil_topup", {
      p_event_id: opts.event ?? unique("evt"), p_user_id: u.id, p_payment_id: opts.payment ?? unique("cs"),
      p_paid_usd: opts.paid ?? credit * 1.5, p_credit_usd: credit, p_charge_id: opts.charge ?? unique("ch"), p_invoice_url: "https://stripe.test/i",
    });
  const month = (u: TestUser, credit: number, opts: { event?: string; invoice?: string; sub?: string; plan?: string; paid?: number; charge?: string } = {}) =>
    rpc("fulfil_plan_invoice", {
      p_event_id: opts.event ?? unique("evt"), p_user_id: u.id, p_invoice_id: opts.invoice ?? unique("in"), p_subscription_id: opts.sub ?? `sub_${u.id}`,
      p_plan: opts.plan ?? "starter", p_price_id: "price_starter", p_paid_usd: opts.paid ?? 19, p_credit_usd: credit,
      p_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(), p_charge_id: opts.charge ?? unique("ch"), p_invoice_url: "https://stripe.test/i",
    });
  const run = async (u: TestUser) => {
    const id = freshRunId();
    const { error } = await u.client.rpc("create_run", { p_id: id, p_topic: "t" });
    if (error) throw new Error(error.message);
    return id;
  };
  const reserve = async (u: TestUser, runId: string, cap: number) => {
    const { data, error } = await u.client.rpc("reserve_credit", { p_run_id: runId, p_kind: "generate", p_cap_usd: cap });
    if (error) throw new Error(error.message);
    return data as string;
  };
  const settle = async (reservation: string, total: number) => Number(await rpc("settle", { p_reservation_id: reservation, p_run_total_usd: total }));
  const kinds = async (u: TestUser) => (await u.client.from("ledger").select("kind,amount_usd,balance_after_usd").order("id")).data!.map((r) => `${r.kind} ${r.amount_usd} → ${r.balance_after_usd}`);

  beforeEach(async () => {
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
  });

  it("grants a top-up as credit that never expires, once per event and once per payment", async () => {
    const event = unique("evt");
    const payment = unique("cs");
    expect(await topup(a, 6, { event, payment, paid: 10 })).toBe("fulfilled");
    expect(await topup(a, 6, { event, payment, paid: 10 })).toBe("duplicate");
    // another of Stripe's events that means the same payment was paid
    expect(await topup(a, 6, { payment, paid: 10 })).toBe("duplicate_payment");
    expect(await account(a)).toEqual({ balance: 6, plan: 0, period: 0 });
    expect(await account(b)).toEqual({ balance: 0, plan: 0, period: 0 });
    expect((await a.client.from("payments").select("id,kind,paid_usd,credit_usd,refunded_usd")).data).toEqual([{ id: payment, kind: "topup", paid_usd: 10, credit_usd: 6, refunded_usd: 0 }]);
    expect(await kinds(a)).toEqual(["purchase 6 → 6"]);
  });

  it("spends the month's credit before a top-up, and gives back what a job did not use to where it came from", async () => {
    await topup(a, 5);
    await month(a, 10);
    expect(await account(a)).toEqual({ balance: 15, plan: 10, period: 1 });
    const id = await run(a);
    // a cap of 12: all 10 of the month's credit and 2 of the top-up
    const held = await reserve(a, id, 12);
    expect(await account(a)).toEqual({ balance: 3, plan: 0, period: 1 });
    expect(await settle(held, 4)).toBe(4);
    // charged 4 from the month's part; 6 of it and the top-up's 2 come back
    expect(await account(a)).toEqual({ balance: 11, plan: 6, period: 1 });

    // a job that costs more than the month has left takes the rest from the top-up
    const more = await reserve(a, await run(a), 9);
    expect(await account(a)).toEqual({ balance: 2, plan: 0, period: 1 });
    expect(await settle(more, 8)).toBe(8);
    expect(await account(a)).toEqual({ balance: 3, plan: 0, period: 1 });
  });

  it("expires what is left of last month at a renewal and leaves top-up credit alone", async () => {
    await topup(a, 5);
    await month(a, 10);
    const held = await reserve(a, await run(a), 3);
    await settle(held, 3);
    expect(await account(a)).toEqual({ balance: 12, plan: 7, period: 1 });
    expect(await month(a, 10)).toBe("fulfilled");
    expect(await account(a)).toEqual({ balance: 15, plan: 10, period: 2 });
    expect((await kinds(a)).slice(-2)).toEqual(["expire -7 → 5", "plan 10 → 15"]);
    expect((await a.client.from("subscriptions").select("plan,status").single()).data).toEqual({ plan: "starter", status: "active" });
  });

  it("does not turn expiring credit into permanent credit when a job holds it across a renewal", async () => {
    await topup(a, 5);
    await month(a, 10);
    // everything is held just before the month ends: 10 from the month, 2 from the top-up
    const held = await reserve(a, await run(a), 12);
    expect(await account(a)).toEqual({ balance: 3, plan: 0, period: 1 });
    await month(a, 10);
    expect(await account(a)).toEqual({ balance: 13, plan: 10, period: 2 });
    // the job cost 4: the 6 it did not use of last month's credit expired with that month; the top-up's 2 return
    expect(await settle(held, 4)).toBe(4);
    expect(await account(a)).toEqual({ balance: 15, plan: 10, period: 2 });
    expect((await kinds(a)).slice(-2)).toEqual(["settle 8 → 21", "expire -6 → 15"]);
  });

  it("ends a subscription by expiring what is left of its month, for that subscription only", async () => {
    await topup(a, 5);
    // (ids of its own: the database is not emptied between runs, and a subscription's id is one user's for good)
    const sub = unique("sub");
    await month(a, 10, { sub });
    expect(await rpc("end_subscription", { p_event_id: unique("evt"), p_user_id: a.id, p_subscription_id: unique("sub") })).toBe("other_subscription");
    expect(await account(a)).toEqual({ balance: 15, plan: 10, period: 1 });
    const event = unique("evt");
    expect(await rpc("end_subscription", { p_event_id: event, p_user_id: a.id, p_subscription_id: sub })).toBe("fulfilled");
    expect(await rpc("end_subscription", { p_event_id: event, p_user_id: a.id, p_subscription_id: sub })).toBe("duplicate");
    expect(await account(a)).toEqual({ balance: 5, plan: 0, period: 2 });
    expect((await a.client.from("subscriptions").select("status").single()).data).toEqual({ status: "canceled" });
  });

  it("takes back the credit of a refunded payment in proportion, once, and below zero if it was spent", async () => {
    const charge = unique("ch");
    await topup(a, 6, { paid: 10, charge });
    const refund = (usd: number, event = unique("evt")) => rpc("refund_payment", { p_event_id: event, p_charge_id: charge, p_refunded_usd: usd });
    // half refunded: half the credit
    const first = unique("evt");
    expect(await refund(5, first)).toBe("fulfilled");
    expect(await refund(5, first)).toBe("duplicate");
    expect((await account(a)).balance).toBe(3);
    // Stripe reports the total refunded so far: the same total again takes nothing more
    expect(await refund(5)).toBe("fulfilled");
    expect((await account(a)).balance).toBe(3);
    // the rest is spent, then refunded as well
    const held = await reserve(a, await run(a), 3);
    await settle(held, 3);
    expect(await refund(10)).toBe("fulfilled");
    expect((await account(a)).balance).toBe(-3);
    expect(await refund(25)).toBe("fulfilled"); // never more than was paid
    expect((await account(a)).balance).toBe(-3);
    expect(await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: "ch_nobody", p_refunded_usd: 5 })).toBe("unknown_payment");
    // in debt, nothing paid starts
    expect((await a.client.rpc("reserve_credit", { p_run_id: await run(a), p_kind: "generate", p_cap_usd: 0.01 })).error?.message).toBe("insufficient_credit");
  });

  it("takes a refunded month's credit out of what could expire, and pays a debt from the next month first", async () => {
    await topup(a, 5);
    const charge = unique("ch");
    await month(a, 10, { paid: 20, charge });
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: charge, p_refunded_usd: 20 });
    expect(await account(a)).toEqual({ balance: 5, plan: 0, period: 1 });

    // b spends a top-up, has it refunded, and so owes 4; the month then grants 10: 6 are left to spend, and to expire
    const bCharge = unique("ch");
    await topup(b, 4, { paid: 8, charge: bCharge });
    await settle(await reserve(b, await run(b), 4), 4);
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: bCharge, p_refunded_usd: 8 });
    expect((await account(b)).balance).toBe(-4);
    await month(b, 10);
    expect(await account(b)).toEqual({ balance: 6, plan: 6, period: 1 });
  });

  it("keeps the books straight when a renewal and several jobs happen at once", async () => {
    await topup(a, 4);
    await month(a, 6);
    // (two jobs at a time is an account's limit; two are enough to race)
    const runs = [await run(a), await run(a)];
    const [first, second, renewed] = await Promise.all([reserve(a, runs[0], 5), reserve(a, runs[1], 5), month(a, 6)]);
    expect(renewed).toBe("fulfilled");
    // whatever the order was: after both jobs settle at no cost, the old month is gone, the new one is whole,
    // and the top-up is whole
    await Promise.all([settle(first, 0), settle(second, 0)]);
    const end = await account(a);
    expect(end.period).toBe(2);
    expect(end.balance).toBe(10);
    expect(end.plan).toBe(6);
    // every row of the ledger adds up to the balance
    const { data: ledger } = await a.client.from("ledger").select("amount_usd");
    expect(Math.round(ledger!.reduce((sum, r) => sum + Number(r.amount_usd), 0) * 10_000) / 10_000).toBe(10);
  });

  it("never lets what can expire be more than what is there, however the credit left", async () => {
    // a month's credit is held by a job, the month is refunded, the job spends nothing
    const charge = unique("ch");
    await month(a, 10, { paid: 20, charge });
    const held = await reserve(a, await run(a), 10);
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: charge, p_refunded_usd: 20 });
    await settle(held, 0);
    expect(await account(a)).toEqual({ balance: 0, plan: 0, period: 1 });
    // the next month is whole: nothing is taken for the refund a second time
    await month(a, 10);
    expect(await account(a)).toEqual({ balance: 10, plan: 10, period: 2 });

    // a top-up is spent and then refunded beside a plan: the debt comes out of what the plan had left
    const spent = unique("ch");
    await topup(b, 5, { paid: 10, charge: spent });
    await month(b, 10);
    await settle(await reserve(b, await run(b), 10), 10); // the plan's 10 are spent first
    await month(b, 10); // a new month: 5 + 10
    expect(await account(b)).toEqual({ balance: 15, plan: 10, period: 2 });
    await settle(await reserve(b, await run(b), 10), 10); // the plan's again: the 5 of the top-up are left
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: spent, p_refunded_usd: 10 });
    expect(await account(b)).toEqual({ balance: 0, plan: 0, period: 2 });
    await month(b, 10);
    expect(await account(b)).toEqual({ balance: 10, plan: 10, period: 3 });
  });

  it("does not take a refunded month twice when its credit was out with a job as the month ended", async () => {
    // the subscription ends while the job runs
    const [charge, sub] = [unique("ch"), unique("sub")];
    await month(a, 10, { paid: 20, charge, sub });
    const held = await reserve(a, await run(a), 10);
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: charge, p_refunded_usd: 20 });
    expect((await account(a)).balance).toBe(-10);
    await rpc("end_subscription", { p_event_id: unique("evt"), p_user_id: a.id, p_subscription_id: sub });
    await settle(held, 0);
    expect(await account(a)).toEqual({ balance: 0, plan: 0, period: 2 });

    // the next month is paid for while the job runs: half of the first month was refunded, and the job spends 2
    const bCharge = unique("ch");
    await month(b, 10, { paid: 20, charge: bCharge });
    const job = await reserve(b, await run(b), 10);
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: bCharge, p_refunded_usd: 10 });
    await month(b, 10);
    // 8 come back; of the 5 of the old month the job still held as plan credit, 2 were used and 3 expire
    await settle(job, 2);
    const end = await account(b);
    expect(end.period).toBe(2);
    expect(end.balance).toBe(10);
    const { data: ledger } = await b.client.from("ledger").select("amount_usd");
    expect(Math.round(ledger!.reduce((sum, r) => sum + Number(r.amount_usd), 0) * 10_000) / 10_000).toBe(10);
  });

  it("does not matter which of two jobs spends, or which settles first, when the month they hold is refunded", async () => {
    // the case one job could not show: a $10 month out with two jobs, half refunded, the subscription ends,
    // one job spends its 5 and the other nothing — the 5 that are handed back are the 5 that were refunded
    for (const [first, second] of [[5, 0], [0, 5]]) {
      for (const olderSettlesFirst of [true, false]) {
        const u = await newUser(s, "two");
        const [charge, sub] = [unique("ch"), unique("sub")];
        await month(u, 10, { paid: 20, charge, sub });
        const jobs = [await reserve(u, await run(u), 5), await reserve(u, await run(u), 5)];
        await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: charge, p_refunded_usd: 10 });
        await rpc("end_subscription", { p_event_id: unique("evt"), p_user_id: u.id, p_subscription_id: sub });
        const order = olderSettlesFirst ? [0, 1] : [1, 0];
        for (const i of order) await settle(jobs[i], [first, second][i]);
        expect(await account(u), `spends ${first}/${second}, ${olderSettlesFirst ? "older" : "newer"} first`).toEqual({ balance: 0, plan: 0, period: 2 });
      }
    }
  });

  it("lets what a job hands back after its month pay a debt before it expires, and takes credit that is merely out for no debt", async () => {
    // credit taken back by hand while the month's credit is out with a job: as without a job, it comes off what
    // could expire, and the month's end takes only the rest
    const sub = unique("sub");
    await month(a, 10, { sub });
    const held = await reserve(a, await run(a), 10);
    await rpc("grant_credit", { p_email: a.email, p_amount_usd: -5, p_note: "taken back" });
    await rpc("end_subscription", { p_event_id: unique("evt"), p_user_id: a.id, p_subscription_id: sub });
    await settle(held, 0);
    expect(await account(a)).toEqual({ balance: 0, plan: 0, period: 2 });
    expect((await kinds(a)).slice(-2)).toEqual(["settle 10 → 5", "expire -5 → 0"]);

    // A balance below zero is not a debt while another job holds what covers it. A top-up is held by one job,
    // the month by another; the top-up is refunded; the month ends; neither job spends anything. Nothing is
    // left, whichever settles first — never the top-up's 6 that were given back to the customer.
    for (const monthFirst of [true, false]) {
      const u = await newUser(s, "out");
      const [charge, plan] = [unique("ch"), unique("sub")];
      await topup(u, 6, { paid: 12, charge });
      await month(u, 10, { sub: plan });
      const ofMonth = await reserve(u, await run(u), 10);
      const ofTopup = await reserve(u, await run(u), 6);
      await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: charge, p_refunded_usd: 12 });
      await rpc("end_subscription", { p_event_id: unique("evt"), p_user_id: u.id, p_subscription_id: plan });
      for (const job of monthFirst ? [ofMonth, ofTopup] : [ofTopup, ofMonth]) await settle(job, 0);
      expect(await account(u), monthFirst ? "the month's job first" : "the top-up's job first").toEqual({ balance: 0, plan: 0, period: 2 });
    }
  });

  it("notes a refund against jobs only for credit that is out with them", async () => {
    const owed = async (u: TestUser) => (await db().from("plan_refunds_out").select("owed_usd").eq("user_id", u.id)).data!.map((r) => Number(r.owed_usd));
    // the month was spent and settled before it was refunded: a plain debt, nothing is out
    const charge = unique("ch");
    await month(a, 10, { paid: 20, charge });
    await settle(await reserve(a, await run(a), 10), 10);
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: charge, p_refunded_usd: 20 });
    expect(await account(a)).toEqual({ balance: -10, plan: 0, period: 1 });
    expect(await owed(a)).toEqual([]);

    // 4 at hand and 6 out: a full refund takes the 4, and notes 6 — not 10 — against the job; a refund reported
    // again with the same total notes nothing more
    const bCharge = unique("ch");
    await month(b, 10, { paid: 20, charge: bCharge });
    const job = await reserve(b, await run(b), 6);
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: bCharge, p_refunded_usd: 10 });
    expect(await owed(b)).toEqual([1]); // half: 5 taken, 4 of them at hand
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: bCharge, p_refunded_usd: 20 });
    await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: bCharge, p_refunded_usd: 20 });
    expect(await owed(b)).toEqual([6]);
    // the job spends 2 of its 6: the 4 it hands back were refunded already, and do not return as plan credit
    await settle(job, 2);
    expect(await account(b)).toEqual({ balance: -2, plan: 0, period: 1 });
    expect(await owed(b)).toEqual([2]);
  });

  it("ends every way a refunded month can go with two jobs out at what a plain sum says", async () => {
    // Every combination of: other credit or none; how much each job holds; how much of the month is refunded;
    // whether the month then ends, is followed by another, or goes on; what each job spends; which settles
    // first. The balance must be what was put in, less what was refunded and spent, less the plan credit that
    // was neither refunded nor spent when its month ended — worked out here without the database's rules.
    const MONTH = 10;
    type Case = { topup: number; caps: [number, number]; refunded: number; then: "goes on" | "ends" | "renews"; spends: [number, number]; order: [number, number] };
    const cases: Case[] = [];
    for (const [topupUsd, caps] of [[0, [5, 5]], [20, [5, 5]], [20, [8, 8]], [20, [3, 4]]] as Array<[number, [number, number]]>) {
      for (const refunded of [0, 0.5, 1]) {
        for (const then of ["goes on", "ends", "renews"] as const) {
          for (const a1 of [0, 2, caps[0]]) {
            for (const a2 of [0, 2, caps[1]]) {
              for (const order of [[0, 1], [1, 0]] as Array<[number, number]>) cases.push({ topup: topupUsd, caps, refunded, then, spends: [a1, a2], order });
            }
          }
        }
      }
    }
    const expected = (c: Case): number => {
      // plan credit is what a job holds first
      const part1 = Math.min(c.caps[0], MONTH);
      const parts = [part1, Math.min(c.caps[1], MONTH - part1)];
      const spent = c.spends[0] + c.spends[1];
      const spentOfPlan = Math.min(c.spends[0], parts[0]) + Math.min(c.spends[1], parts[1]);
      const takenBack = MONTH * c.refunded;
      const unusedAtMonthsEnd = c.then === "goes on" ? 0 : Math.max(MONTH - takenBack - spentOfPlan, 0);
      return c.topup + MONTH - takenBack - spent - unusedAtMonthsEnd + (c.then === "renews" ? MONTH : 0);
    };
    const play = async (c: Case): Promise<string | null> => {
      const u = await newUser(s, "sum");
      const [charge, sub] = [unique("ch"), unique("sub")];
      if (c.topup > 0) await topup(u, c.topup);
      await month(u, MONTH, { paid: 20, charge, sub });
      const jobs = [await reserve(u, await run(u), c.caps[0]), await reserve(u, await run(u), c.caps[1])];
      if (c.refunded > 0) await rpc("refund_payment", { p_event_id: unique("evt"), p_charge_id: charge, p_refunded_usd: 20 * c.refunded });
      if (c.then === "ends") await rpc("end_subscription", { p_event_id: unique("evt"), p_user_id: u.id, p_subscription_id: sub });
      if (c.then === "renews") await month(u, MONTH, { sub });
      for (const i of c.order) await settle(jobs[i], c.spends[i]);
      const end = await account(u);
      const { data: ledger } = await u.client.from("ledger").select("amount_usd");
      const summed = Math.round(ledger!.reduce((sum, r) => sum + Number(r.amount_usd), 0) * 10_000) / 10_000;
      const wrong = [
        end.balance !== expected(c) && `balance ${end.balance}, expected ${expected(c)}`,
        summed !== end.balance && `the ledger adds up to ${summed}, the balance is ${end.balance}`,
        (end.plan < 0 || end.plan > Math.max(end.balance, 0)) && `plan credit ${end.plan} with a balance of ${end.balance}`,
      ].filter(Boolean);
      return wrong.length > 0 ? `${JSON.stringify(c)}: ${wrong.join("; ")}` : null;
    };
    const failures: string[] = [];
    // a dozen at a time: each is a user of its own
    for (let i = 0; i < cases.length; i += 12) {
      failures.push(...(await Promise.all(cases.slice(i, i + 12).map(play))).filter((f): f is string => f !== null));
    }
    expect(cases).toHaveLength(648);
    expect(failures).toEqual([]);
  }, 600_000);

  it("takes credit back by hand out of the plan's when nothing else is left, and expires only what remains", async () => {
    await month(a, 10);
    expect(Number(await rpc("grant_credit", { p_email: a.email, p_amount_usd: -8, p_note: "taken back" }))).toBe(2);
    expect(await account(a)).toEqual({ balance: 2, plan: 2, period: 1 });
    await month(a, 10);
    expect(await account(a)).toEqual({ balance: 10, plan: 10, period: 2 });
    expect(await kinds(a)).toEqual(["plan 10 → 10", "grant -8 → 2", "expire -2 → 0", "plan 10 → 10"]);
  });

  it("applies a refund that came before its payment was recorded, once the payment is there", async () => {
    // (a payment whose fulfilment is still failing can be refunded meanwhile)
    const charge = unique("ch");
    const event = unique("evt");
    const refund = () => rpc("refund_payment", { p_event_id: event, p_charge_id: charge, p_refunded_usd: 10 });
    expect(await refund()).toBe("unknown_payment");
    // not recorded as done: it can be offered again
    expect((await db().from("stripe_events").select("id").eq("id", event)).data).toEqual([]);
    expect(await refund()).toBe("unknown_payment");
    await topup(a, 6, { paid: 10, charge });
    expect(await refund()).toBe("fulfilled");
    expect(await refund()).toBe("duplicate");
    expect((await account(a)).balance).toBe(0);
  });

  it("fulfils a month once per event and once per invoice, and mirrors a subscription once per event", async () => {
    const [event, invoice, sub] = [unique("evt"), unique("in"), unique("sub")];
    expect(await month(a, 10, { event, invoice, sub })).toBe("fulfilled");
    expect(await month(a, 10, { event, invoice, sub })).toBe("duplicate");
    // Stripe may tell of the same paid invoice in another event
    expect(await month(a, 10, { invoice, sub })).toBe("duplicate_payment");
    expect(await account(a)).toEqual({ balance: 10, plan: 10, period: 1 });
    const again = unique("evt");
    const sync = () => rpc("sync_subscription", { p_event_id: again, p_user_id: a.id, p_subscription_id: sub, p_plan: "starter", p_price_id: "price_starter", p_status: "past_due", p_period_end: "2026-11-08T00:00:00Z", p_cancel_at_period_end: false });
    expect(await sync()).toBe("fulfilled");
    expect(await sync()).toBe("duplicate");
    // the subscription ends once, whatever number of events say so
    expect(await rpc("end_subscription", { p_event_id: unique("evt"), p_user_id: a.id, p_subscription_id: sub })).toBe("fulfilled");
    expect(await rpc("end_subscription", { p_event_id: unique("evt"), p_user_id: a.id, p_subscription_id: sub })).toBe("already_ended");
    expect(await account(a)).toEqual({ balance: 0, plan: 0, period: 2 });
  });

  it("refuses an amount that is no amount, in every function that takes one", async () => {
    const bad = [Number.NaN, -1, 1e9, null];
    for (const usd of bad) {
      const calls: Array<[string, Record<string, unknown>]> = [
        ["fulfil_topup", { p_event_id: unique("evt"), p_user_id: a.id, p_payment_id: unique("cs"), p_paid_usd: usd, p_credit_usd: 1, p_charge_id: null, p_invoice_url: null }],
        ["fulfil_topup", { p_event_id: unique("evt"), p_user_id: a.id, p_payment_id: unique("cs"), p_paid_usd: 1, p_credit_usd: usd, p_charge_id: null, p_invoice_url: null }],
        ["fulfil_plan_invoice", { p_event_id: unique("evt"), p_user_id: a.id, p_invoice_id: unique("in"), p_subscription_id: unique("sub"), p_plan: "starter", p_price_id: "p", p_paid_usd: 1, p_credit_usd: usd, p_period_end: new Date().toISOString() }],
        ["refund_payment", { p_event_id: unique("evt"), p_charge_id: unique("ch"), p_refunded_usd: usd }],
      ];
      for (const [name, args] of calls) expect((await db().rpc(name, args)).error, `${name} ${String(usd)}`).not.toBeNull();
    }
    expect(await account(a)).toEqual({ balance: 0, plan: 0, period: 0 });
    expect((await a.client.from("payments").select("id")).data).toEqual([]);
  });

  it("grants for a second subscription that was paid for, without ending the first one's month", async () => {
    const [first, second] = [unique("sub"), unique("sub")];
    expect(await month(a, 10, { sub: first })).toBe("fulfilled");
    expect(await month(a, 30, { sub: second, plan: "pro" })).toBe("second_subscription");
    // both were paid: both are there, and nothing of the first expired
    expect(await account(a)).toEqual({ balance: 40, plan: 40, period: 1 });
    expect((await a.client.from("subscriptions").select("stripe_subscription_id,plan").single()).data).toEqual({ stripe_subscription_id: first, plan: "starter" });
    expect((await a.client.from("payments").select("id")).data).toHaveLength(2);
    // the first one's next month ends the month for all of it
    expect(await month(a, 10, { sub: first })).toBe("fulfilled");
    expect(await account(a)).toEqual({ balance: 10, plan: 10, period: 2 });
  });

  it("mirrors a subscription from Stripe without granting anything, and keeps to the first when there are two", async () => {
    const sync = (sub: string, status: string, event = unique("evt")) =>
      rpc("sync_subscription", { p_event_id: event, p_user_id: a.id, p_subscription_id: sub, p_plan: "pro", p_price_id: "price_pro", p_status: status, p_period_end: "2026-11-08T00:00:00Z", p_cancel_at_period_end: true });
    const [first, second] = [unique("sub"), unique("sub")];
    expect(await sync(first, "past_due")).toBe("fulfilled");
    expect((await a.client.from("subscriptions").select("stripe_subscription_id,plan,status,cancel_at_period_end").single()).data)
      .toEqual({ stripe_subscription_id: first, plan: "pro", status: "past_due", cancel_at_period_end: true });
    expect(await sync(second, "active")).toBe("other_subscription");
    expect((await a.client.from("subscriptions").select("stripe_subscription_id").single()).data).toEqual({ stripe_subscription_id: first });
    expect(await account(a)).toEqual({ balance: 0, plan: 0, period: 0 });
    expect((await b.client.from("subscriptions").select("*")).data).toEqual([]);
  });

  it("links a Stripe customer to one user, and a user to one customer", async () => {
    const customer = unique("cus");
    const link = (u: TestUser, id: string) => db().rpc("link_stripe_customer", { p_user_id: u.id, p_customer_id: id });
    expect((await link(a, customer)).error).toBeNull();
    expect((await link(a, customer)).error).toBeNull(); // again: nothing to do
    expect((await link(b, customer)).error?.message).toBe("customer_taken");
    expect((await link(a, unique("cus"))).error?.message).toBe("already_linked");
    expect((await link(b, "not-a-customer")).error?.message).toBe("invalid_customer");
  });

  it("is none of it a user's to call or to write: only reading their own payments and plan", async () => {
    await month(a, 10);
    await topup(b, 3);
    const event = unique("evt");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["fulfil_topup", { p_event_id: event, p_user_id: a.id, p_payment_id: unique("cs"), p_paid_usd: 1, p_credit_usd: 1000 }],
      ["fulfil_plan_invoice", { p_event_id: event, p_user_id: a.id, p_invoice_id: unique("in"), p_subscription_id: "sub_x", p_plan: "pro", p_price_id: "p", p_paid_usd: 1, p_credit_usd: 1000, p_period_end: new Date().toISOString() }],
      ["sync_subscription", { p_event_id: event, p_user_id: a.id, p_subscription_id: "sub_x", p_plan: "pro", p_price_id: "p", p_status: "active", p_period_end: new Date().toISOString(), p_cancel_at_period_end: false }],
      ["end_subscription", { p_event_id: event, p_user_id: b.id, p_subscription_id: "sub_x" }],
      ["refund_payment", { p_event_id: event, p_charge_id: "ch_x", p_refunded_usd: 1 }],
      ["link_stripe_customer", { p_user_id: a.id, p_customer_id: "cus_mine" }],
      ["claim_stripe_event", { p_event_id: event, p_type: "x", p_user_id: a.id }],
      ["expire_plan_credit", { p_user_id: b.id, p_note: "x" }],
    ];
    for (const [name, args] of calls) expect((await a.client.rpc(name, args)).error?.code, name).toBe("42501");
    expect((await a.client.from("payments").insert({ id: "x", user_id: a.id, kind: "topup", paid_usd: 0, credit_usd: 99 })).error?.code).toBe("42501");
    expect((await a.client.from("subscriptions").update({ plan: "pro" }).eq("user_id", a.id)).error?.code).toBe("42501");
    expect((await a.client.from("users").update({ plan_credit_usd: 0, balance_usd: 99 }).eq("id", a.id)).error?.code).toBe("42501");
    expect((await a.client.from("stripe_events").select("*")).error?.code).toBe("42501");
    expect((await a.client.from("plan_refunds_out").select("*")).error?.code).toBe("42501");
    expect((await a.client.from("plan_refunds_out").insert({ user_id: a.id, plan_period: 0, owed_usd: 99 })).error?.code).toBe("42501");
    // their own, and nobody else's
    expect((await a.client.from("payments").select("user_id")).data).toEqual([{ user_id: a.id }]);
    expect((await a.client.from("payments").select("*").eq("user_id", b.id)).data).toEqual([]);
    expect((await b.client.from("subscriptions").select("*")).data).toEqual([]);
    expect(await account(a)).toEqual({ balance: 10, plan: 10, period: 1 });
  });

  it("refuses an amount that is not one", async () => {
    for (const amount of [null, "NaN", -1, "Infinity"]) {
      expect((await db().rpc("fulfil_topup", { p_event_id: unique("evt"), p_user_id: a.id, p_payment_id: unique("cs"), p_paid_usd: 1, p_credit_usd: amount })).error, String(amount)).not.toBeNull();
    }
    expect(await account(a)).toEqual({ balance: 0, plan: 0, period: 0 });
    expect((await db().from("stripe_events").select("id").eq("user_id", a.id)).data).toEqual([]);
  });
});
