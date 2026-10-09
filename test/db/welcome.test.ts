import { describe, expect, it } from "vitest";
import { localDb, newUser, serviceClient, type TestUser, visitorDb } from "../helpers/db.js";

/*
 * Welcome credit in the database (Phase 4 spec §8), against the local Postgres container. The setting that turns it
 * on is one row every account shares, and other test files make accounts at the same time: so it is never
 * changed here. The grant takes its amount and its cap as parameters, and is tested through them; what is given
 * away "today" is counted from wherever it stands when a test starts.
 */
const supa = localDb();

describe.skipIf(!supa)("welcome credit", () => {
  const s = supa!;
  const db = () => serviceClient(s);
  const anon = () => visitorDb(s);
  const welcome = async (u: { id: string }, amount: unknown, cap: unknown) => {
    const { data, error } = await db().rpc("grant_welcome_credit", { p_user_id: u.id, p_amount: amount, p_cap: cap });
    if (error) throw new Error(error.message);
    return Number(data);
  };
  const balance = async (u: TestUser) => Number((await db().from("users").select("balance_usd").eq("id", u.id).single()).data!.balance_usd);
  const rows = async (u: TestUser) => (await u.client.from("ledger").select("kind,amount_usd,balance_after_usd,note").order("id")).data;
  /** What has been given away in the last day, by this file's earlier tests and runs. */
  const givenToday = async () => {
    const { data } = await db().from("ledger").select("amount_usd").eq("kind", "grant").eq("note", "welcome").gt("created_at", new Date(Date.now() - 86_400_000).toISOString());
    return Math.round((data ?? []).reduce((sum, r) => sum + Number(r.amount_usd), 0) * 10_000) / 10_000;
  };

  it("is off unless the owner turns it on: a new account starts with nothing, and nobody is promised anything", async () => {
    const u = await newUser(s, "plain");
    expect(await balance(u)).toBe(0);
    expect(await rows(u)).toEqual([]);
    const settings = (await db().from("settings").select("welcome_credit_usd,welcome_daily_cap_usd").single()).data!;
    expect([Number(settings.welcome_credit_usd), Number(settings.welcome_daily_cap_usd)]).toEqual([0, 5]);
    // what a visitor's page may ask, without a session: whether a new account would be given something
    const offer = await anon().rpc("welcome_offer");
    expect([offer.error, Number(offer.data)]).toEqual([null, 0]);
  });

  it("is given to an account once", async () => {
    const u = await newUser(s, "once");
    const room = (await givenToday()) + 1;
    expect(await welcome(u, 0.05, room)).toBe(0.05);
    expect(await welcome(u, 0.05, room)).toBe(0);
    expect(await welcome(u, 0.5, room)).toBe(0);
    expect(await balance(u)).toBe(0.05);
    expect(await rows(u)).toEqual([{ kind: "grant", amount_usd: 0.05, balance_after_usd: 0.05, note: "welcome" }]);
    // it is ordinary credit that does not expire, and too little to hold a clip's worth
    const { data: account } = await db().from("users").select("plan_credit_usd").eq("id", u.id).single();
    expect(Number(account!.plan_credit_usd)).toBe(0);
  });

  it("stops at the day's cap, however many accounts ask at once", async () => {
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => newUser(s, `flood${i}`)));
    // room for exactly two more of five cents
    const cap = (await givenToday()) + 0.12;
    const granted = await Promise.all(users.map((u) => welcome(u, 0.05, cap)));
    expect(granted.filter((g) => g === 0.05)).toHaveLength(2);
    expect(granted.filter((g) => g === 0)).toHaveLength(4);
    expect((await Promise.all(users.map(balance))).reduce((a, b) => a + b, 0)).toBeCloseTo(0.1, 6);
    // and stays stopped: the next account gets nothing under that cap
    expect(await welcome(await newUser(s, "late"), 0.05, cap)).toBe(0);
  });

  it("gives nothing for an amount that is none, or to nobody", async () => {
    const u = await newUser(s, "none");
    const room = (await givenToday()) + 1;
    for (const amount of [0, -0.05, Number.NaN, 5.01, null]) expect(await welcome(u, amount, room), String(amount)).toBe(0);
    for (const cap of [Number.NaN, null, 0]) expect(await welcome(u, 0.05, cap), `cap ${String(cap)}`).toBe(0);
    expect(await welcome({ id: "00000000-0000-4000-8000-000000000000" }, 0.05, room)).toBe(0);
    expect(await balance(u)).toBe(0);
  });

  it("is nobody's to take: a user can neither grant it nor read or change the setting", async () => {
    const u = await newUser(s, "taker");
    expect((await u.client.rpc("grant_welcome_credit", { p_user_id: u.id, p_amount: 5, p_cap: 1000 })).error?.code).toBe("42501");
    expect((await anon().rpc("grant_welcome_credit", { p_user_id: u.id, p_amount: 5, p_cap: 1000 })).error?.code).toBe("42501");
    expect((await u.client.from("settings").select("*")).error?.code).toBe("42501");
    expect((await u.client.from("settings").update({ welcome_credit_usd: 5 }).eq("only_row", true)).error?.code).toBe("42501");
    expect(await balance(u)).toBe(0);
    // the owner cannot set it beyond a few dollars by a slip either
    expect((await db().from("settings").update({ welcome_credit_usd: 50 }).eq("only_row", true)).error?.code).toBe("23514");
  });
});
