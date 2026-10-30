import { describe, expect, it } from "vitest";
import { freshRunId, localDb, newUser, serviceClient, visitorDb, type TestUser } from "../helpers/db.js";

/*
 * Topic ideas in the database alone (phase 13 spec §5, plan ruling 1): a request is a hidden run row, its price is held
 * with `reserve_credit` as a job of kind "ideas" and settled by the one function that settles. Every test makes its own
 * users and run ids: other test files use the same database at the same time.
 */
const supa = localDb();
let n = 0;
const unique = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!supa)("topic ideas in the database", () => {
  const s = supa!;
  const svc = () => serviceClient(s);
  const account = async (u: TestUser) => {
    const { data } = await svc().from("users").select("balance_usd,plan_credit_usd").eq("id", u.id).single();
    return { balance: Number(data!.balance_usd), plan: Number(data!.plan_credit_usd) };
  };
  const fund = async (u: TestUser, usd: number) => {
    const { error } = await svc().rpc("grant_credit", { p_email: u.email, p_amount_usd: usd, p_note: "test" });
    if (error) throw new Error(error.message);
  };
  const month = async (u: TestUser, credit: number) => {
    const { error } = await svc().rpc("fulfil_plan_invoice", {
      p_event_id: unique("evt"), p_user_id: u.id, p_invoice_id: unique("in"), p_subscription_id: `sub_${u.id}`, p_plan: "starter", p_price_id: "price_starter",
      p_paid_usd: 19, p_credit_usd: credit, p_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(), p_charge_id: unique("ch"), p_invoice_url: "https://stripe.test/i",
    });
    if (error) throw new Error(error.message);
  };
  const request = async (u: TestUser) => {
    const id = freshRunId();
    const { error } = await u.client.rpc("create_idea_request", { p_id: id });
    if (error) throw new Error(error.message);
    return id;
  };
  const hold = async (u: TestUser, runId: string, cap: number, kind = "ideas") => {
    const { data, error } = await u.client.rpc("reserve_credit", { p_run_id: runId, p_kind: kind, p_cap_usd: cap });
    if (error) throw new Error(error.message);
    return data as string;
  };
  const settle = async (reservation: string, total: number) => {
    const { data, error } = await svc().rpc("settle", { p_reservation_id: reservation, p_run_total_usd: total });
    if (error) throw new Error(error.message);
    return Number(data);
  };

  it("registers a request as the caller's, in a state no list of videos shows, and as nobody else's", async () => {
    const [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
    const id = await request(a);
    expect((await a.client.from("runs").select("id,state,topic").eq("id", id)).data).toEqual([{ id, state: "ideas", topic: "" }]);
    expect((await b.client.from("runs").select("id").eq("id", id)).data).toEqual([]);
  });

  it("refuses a visitor, a repeated id, and the worker's role (it is the web's to register a request)", async () => {
    const a = await newUser(s, "a");
    expect((await visitorDb(s).rpc("create_idea_request", { p_id: freshRunId() })).error?.message).toBe("unauthenticated");
    const id = await request(a);
    expect((await a.client.rpc("create_idea_request", { p_id: id })).error?.message).toBe("run_exists");
    expect((await svc().rpc("create_idea_request", { p_id: freshRunId() })).error?.message).toMatch(/permission denied/);
  });

  it("holds the price and keeps all of it when the ideas came", async () => {
    const a = await newUser(s, "a");
    await fund(a, 1);
    const held = await hold(a, await request(a), 0.05);
    expect(await account(a)).toEqual({ balance: 0.95, plan: 0 });
    expect(await settle(held, 0.05)).toBe(0.05);
    expect(await account(a)).toEqual({ balance: 0.95, plan: 0 });
  });

  it("gives back all of it when no ideas came, and settling twice changes nothing", async () => {
    const a = await newUser(s, "a");
    await fund(a, 1);
    const held = await hold(a, await request(a), 0.05);
    expect(await settle(held, 0)).toBe(0);
    expect(await account(a)).toEqual({ balance: 1, plan: 0 });
    expect(await settle(held, 0.05)).toBe(0);
    expect(await account(a)).toEqual({ balance: 1, plan: 0 });
  });

  it("takes the price from the month's credit first and returns an unspent price to it", async () => {
    const a = await newUser(s, "a");
    await month(a, 2);
    const held = await hold(a, await request(a), 0.05);
    expect(await account(a)).toEqual({ balance: 1.95, plan: 1.95 });
    await settle(held, 0);
    expect(await account(a)).toEqual({ balance: 2, plan: 2 });
  });

  it("refuses without credit, on another user's request, a second hold on one request, and a kind that is not one", async () => {
    const [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
    const mine = await request(a);
    await expect(hold(a, mine, 0.05)).rejects.toThrow("insufficient_credit");
    await fund(a, 1);
    await expect(hold(b, mine, 0.05)).rejects.toThrow("not_found");
    await hold(a, mine, 0.05);
    await expect(hold(a, mine, 0.05)).rejects.toThrow("job_active");
    await expect(hold(a, await request(a), 0.05, "bogus")).rejects.toThrow("invalid_kind");
  });
});
