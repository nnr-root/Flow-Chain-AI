import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";
import { freshRunId, localSupabase, newUser, serviceClient, type TestUser } from "../helpers/supabase.js";

/*
 * The database on its own, against the local Supabase stack: a signed-in user talks to it directly here, the
 * way anyone can with their own token, without the studio in between. Skipped when the stack is not running.
 * Other test files use the same database at the same time: every test here makes its own users and run ids
 * and looks only at them.
 */
const supa = localSupabase();
const TABLES = ["users", "runs", "reservations", "ledger", "brand_kits", "music_tracks"] as const;

describe.skipIf(!supa)("tenancy in the database", () => {
  const s = supa!;
  const service = () => serviceClient(s);
  let a: TestUser;
  let b: TestUser;
  let RUN_A: string;
  let RUN_B: string;
  const both = () => [a.id, b.id];
  const balance = async (u: TestUser) => Number((await service().from("users").select("balance_usd").eq("id", u.id).single()).data!.balance_usd);
  const grant = async (u: TestUser, usd: number) => {
    const { error } = await service().rpc("grant_credit", { p_email: u.email, p_amount_usd: usd, p_note: "test" });
    if (error) throw new Error(error.message);
  };
  const run = async (u: TestUser, id: string) => {
    const { error } = await u.client.rpc("create_run", { p_id: id, p_topic: "a topic" });
    if (error) throw new Error(error.message);
  };
  const reserve = (u: TestUser, runId: string, cap: number, kind = "generate") => u.client.rpc("reserve_credit", { p_run_id: runId, p_kind: kind, p_cap_usd: cap });

  beforeEach(async () => {
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
    [RUN_A, RUN_B] = [freshRunId(), freshRunId()];
  });

  it("gives a new account its row, with nothing to spend", async () => {
    const { data } = await a.client.from("users").select("*");
    expect(data).toEqual([expect.objectContaining({ id: a.id, email: a.email, balance_usd: 0 })]);
  });

  it("shows a user their own rows and nobody else's, in every table", async () => {
    await Promise.all([grant(a, 5), grant(b, 5)]);
    await Promise.all([run(a, RUN_A), run(b, RUN_B)]);
    for (const [u, id] of [[a, RUN_A], [b, RUN_B]] as const) {
      expect((await reserve(u, id, 1)).error).toBeNull();
      expect((await u.client.rpc("register_brand_kit", { p_slug: "kit", p_name: "Kit" })).error).toBeNull();
      expect((await u.client.rpc("register_track", { p_id: "track", p_name: "Track", p_bytes: 10 })).error).toBeNull();
    }
    for (const table of TABLES) {
      const owner = table === "users" ? "id" : "user_id";
      const { data, error } = await a.client.from(table).select("*");
      expect(error, table).toBeNull();
      expect(data!.length, table).toBeGreaterThan(0);
      expect(data!.every((row) => (row as Record<string, unknown>)[owner] === a.id), table).toBe(true);
      // asking for the other user's rows by name finds nothing
      expect((await a.client.from(table).select("*").eq(owner, b.id)).data, table).toEqual([]);
    }
    expect((await a.client.from("runs").select("*").eq("id", RUN_B)).data).toEqual([]);
    expect((await a.client.from("settings").select("*")).data ?? []).toEqual([]);
  });

  it("shows someone who is not signed in nothing at all", async () => {
    await run(a, RUN_A);
    const anon = createClient(s.url, s.anonKey, { auth: { persistSession: false } });
    for (const table of [...TABLES, "settings"]) {
      const { data } = await anon.from(table).select("*");
      expect(data ?? [], table).toEqual([]);
    }
    expect((await anon.rpc("create_run", { p_id: RUN_B, p_topic: "x" })).error).not.toBeNull();
    expect((await anon.rpc("reserve_credit", { p_run_id: RUN_A, p_kind: "generate", p_cap_usd: 0 })).error).not.toBeNull();
  });

  it("refuses every direct write: a user cannot give themselves credit, a run, or anyone's rows", async () => {
    await grant(a, 1);
    await run(a, RUN_A);
    await run(b, RUN_B);
    // each of these changes nothing: refused outright, or matching no row the user may touch
    await a.client.from("users").update({ balance_usd: 1000 }).eq("id", a.id);
    await a.client.from("users").update({ balance_usd: 1000 }).eq("id", b.id);
    await a.client.from("runs").update({ user_id: a.id }).eq("id", RUN_B);
    await a.client.from("runs").update({ charged_usd: 0, state: "done" }).eq("id", RUN_A);
    await a.client.from("runs").delete().eq("id", RUN_B);
    await a.client.from("ledger").delete().eq("user_id", a.id);
    await a.client.from("ledger").update({ amount_usd: 500 }).eq("user_id", a.id);
    await a.client.from("brand_kits").delete().eq("user_id", b.id);
    await a.client.from("music_tracks").update({ bytes: 1 }).eq("user_id", b.id);
    await a.client.from("reservations").update({ status: "settled" }).eq("user_id", a.id);
    // each of the writes above was refused for lack of permission, not merely aimed at rows it could not see
    expect((await a.client.from("users").update({ balance_usd: 1000 }).eq("id", a.id)).error?.code).toBe("42501");
    expect((await a.client.from("ledger").delete().eq("user_id", a.id)).error?.code).toBe("42501");
    expect((await a.client.from("runs").insert({ id: freshRunId(), user_id: a.id })).error).not.toBeNull();
    expect((await a.client.from("ledger").insert({ user_id: a.id, kind: "grant", amount_usd: 50, balance_after_usd: 50 })).error).not.toBeNull();
    expect((await a.client.from("reservations").insert({ user_id: a.id, run_id: RUN_A, kind: "generate", cap_usd: 0 })).error).not.toBeNull();
    expect((await a.client.from("users").insert({ id: crypto.randomUUID(), email: "x@example.test", balance_usd: 9 })).error).not.toBeNull();

    expect(await balance(a)).toBe(1);
    expect(await balance(b)).toBe(0);
    const runs = (await service().from("runs").select("id,user_id,state,charged_usd").in("user_id", both())).data!;
    expect(runs.sort((x, y) => (x.user_id === a.id ? -1 : 1) - (y.user_id === a.id ? -1 : 1))).toEqual([
      { id: RUN_A, user_id: a.id, state: "creating", charged_usd: 0 },
      { id: RUN_B, user_id: b.id, state: "creating", charged_usd: 0 },
    ]);
    expect((await service().from("ledger").select("amount_usd").eq("user_id", a.id)).data).toEqual([{ amount_usd: 1 }]);
  });

  it("keeps the money functions for the worker: a user cannot settle, grant or set a run's state", async () => {
    await grant(a, 1);
    await run(a, RUN_A);
    const { data: reservation } = await reserve(a, RUN_A, 1);
    const anon = createClient(s.url, s.anonKey, { auth: { persistSession: false } });
    for (const [name, args] of [
      ["settle", { p_reservation_id: reservation, p_run_total_usd: 0 }],
      ["grant_credit", { p_email: a.email, p_amount_usd: 100, p_note: "" }],
      ["set_run_state", { p_run_id: RUN_A, p_state: "done" }],
    ] as const) {
      // 42501: permission denied — refused for who is asking, not for what was asked
      expect((await a.client.rpc(name, args)).error?.code, name).toBe("42501");
      expect((await anon.rpc(name, args)).error?.code, `${name} (not signed in)`).toBe("42501");
    }
    expect(await balance(a)).toBe(0);
    expect((await service().from("runs").select("state").eq("id", RUN_A).single()).data).toEqual({ state: "creating" });
    expect((await service().from("reservations").select("status").eq("id", reservation).single()).data).toEqual({ status: "open" });
  });

  it("reserves a cap out of the balance and writes the ledger", async () => {
    await grant(a, 2);
    await run(a, RUN_A);
    const { data: id, error } = await reserve(a, RUN_A, 0.31);
    expect(error).toBeNull();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await balance(a)).toBe(1.69);
    const { data: ledger } = await a.client.from("ledger").select("kind,amount_usd,balance_after_usd,run_id,reservation_id").order("id");
    expect(ledger).toEqual([
      { kind: "grant", amount_usd: 2, balance_after_usd: 2, run_id: null, reservation_id: null },
      { kind: "reserve", amount_usd: -0.31, balance_after_usd: 1.69, run_id: RUN_A, reservation_id: id },
    ]);
  });

  it.each([
    ["a run that is someone else's", async () => reserve(a, RUN_B, 0.1), "not_found"],
    ["a run that does not exist", async () => reserve(a, freshRunId(), 0.1), "not_found"],
    ["more than the balance", async () => reserve(a, RUN_A, 2.0001), "insufficient_credit"],
    ["a negative amount", async () => reserve(a, RUN_A, -1), "invalid_amount"],
    ["an unknown kind of job", async () => reserve(a, RUN_A, 0.1, "rerender"), "invalid_kind"],
  ])("refuses to reserve for %s", async (_what, attempt, message) => {
    await grant(a, 2);
    await run(a, RUN_A);
    await run(b, RUN_B);
    const { error } = await attempt();
    expect(error?.message).toBe(message);
    expect(await balance(a)).toBe(2);
    expect((await service().from("reservations").select("id").in("user_id", both())).data).toEqual([]);
  });

  it("allows one paid job per run and two per user", async () => {
    await grant(a, 5);
    const ids = [RUN_A, freshRunId(), freshRunId()];
    for (const id of ids) await run(a, id);
    expect((await reserve(a, ids[0], 1)).error).toBeNull();
    expect((await reserve(a, ids[0], 1)).error?.message).toBe("job_active");
    expect((await reserve(a, ids[1], 1)).error).toBeNull();
    expect((await reserve(a, ids[2], 1)).error?.message).toBe("too_many_jobs");
    expect(await balance(a)).toBe(3);
  });

  it("cannot be raced into spending the same credit twice", async () => {
    await grant(a, 1);
    const ids = Array.from({ length: 12 }, () => freshRunId());
    for (const id of ids) await run(a, id);
    // twelve tabs at once, each asking for 0.6 of a balance of 1: one gets it
    const results = await Promise.all(ids.map((id) => reserve(a, id, 0.6)));
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.filter((r) => r.error).map((r) => r.error!.message)).toEqual(Array(11).fill("insufficient_credit"));
    expect(await balance(a)).toBe(0.4);
  });

  it("settles at the real cost, returns the rest, and does nothing the second time", async () => {
    await grant(a, 2);
    await run(a, RUN_A);
    const first = (await reserve(a, RUN_A, 1)).data as string;
    // the run's manifest says 0.27 was spent in all
    expect((await service().rpc("settle", { p_reservation_id: first, p_run_total_usd: 0.27 })).data).toBe(0.27);
    expect(await balance(a)).toBe(1.73);
    expect((await service().rpc("settle", { p_reservation_id: first, p_run_total_usd: 0.9 })).data).toBe(0.27);
    expect(await balance(a)).toBe(1.73);

    // a reroll later: the run's total is now 0.35, of which 0.27 is already paid for
    const second = (await reserve(a, RUN_A, 0.5, "reroll")).data as string;
    expect(await balance(a)).toBe(1.23);
    expect((await service().rpc("settle", { p_reservation_id: second, p_run_total_usd: 0.35 })).data).toBe(0.08);
    expect(await balance(a)).toBe(1.65);
    expect((await service().from("runs").select("charged_usd").eq("id", RUN_A).single()).data).toEqual({ charged_usd: 0.35 });
    const kinds = (await a.client.from("ledger").select("kind,amount_usd,balance_after_usd").order("id")).data;
    expect(kinds).toEqual([
      { kind: "grant", amount_usd: 2, balance_after_usd: 2 },
      { kind: "reserve", amount_usd: -1, balance_after_usd: 1 },
      { kind: "settle", amount_usd: 0.73, balance_after_usd: 1.73 },
      { kind: "reserve", amount_usd: -0.5, balance_after_usd: 1.23 },
      { kind: "settle", amount_usd: 0.42, balance_after_usd: 1.65 },
    ]);
  });

  it("returns the whole cap for a job that never spent, and charges past the cap when a provider did", async () => {
    await grant(a, 1);
    await run(a, RUN_A);
    const unused = (await reserve(a, RUN_A, 0.5)).data as string;
    expect((await service().rpc("settle", { p_reservation_id: unused, p_run_total_usd: 0 })).data).toBe(0);
    expect(await balance(a)).toBe(1);

    const over = (await reserve(a, RUN_A, 1)).data as string;
    expect((await service().rpc("settle", { p_reservation_id: over, p_run_total_usd: 1.2 })).data).toBe(1.2);
    expect(await balance(a)).toBe(-0.2);
    // in debt: nothing paid can be started until it is topped up
    expect((await reserve(a, RUN_A, 0)).error?.message).toBe("insufficient_credit");
  });

  it("never settles on a total that is missing or impossible: the reservation stays open", async () => {
    await grant(a, 1);
    await run(a, RUN_A);
    const id = (await reserve(a, RUN_A, 0.5)).data as string;
    for (const total of [null, "NaN", -1, "Infinity"]) {
      expect((await service().rpc("settle", { p_reservation_id: id, p_run_total_usd: total })).error, String(total)).not.toBeNull();
    }
    expect(await balance(a)).toBe(0.5);
    expect((await service().from("reservations").select("status").eq("id", id).single()).data).toEqual({ status: "open" });
    // and no amount that is not a number ever reaches a balance
    for (const amount of ["NaN", "Infinity", 0, null]) {
      expect((await service().rpc("grant_credit", { p_email: a.email, p_amount_usd: amount })).error, String(amount)).not.toBeNull();
    }
    expect((await reserve(a, RUN_A, "NaN" as unknown as number)).error).not.toBeNull();
    expect(await balance(a)).toBe(0.5);
  });

  it("limits what one account can register without spending anything", async () => {
    // twenty runs that never started is the limit: the twenty-first is refused until one of them has
    const ids = Array.from({ length: 21 }, () => freshRunId());
    const made = await Promise.all(ids.map((id) => a.client.rpc("create_run", { p_id: id, p_topic: "x" })));
    expect(made.filter((r) => !r.error)).toHaveLength(20);
    expect(made.filter((r) => r.error).map((r) => r.error!.message)).toEqual(["too_many_runs"]);
    const started = ids.find((_, i) => !made[i].error)!;
    await service().rpc("set_run_state", { p_run_id: started, p_state: "draft" });
    expect((await a.client.rpc("create_run", { p_id: freshRunId(), p_topic: "x" })).error).toBeNull();
    // b is not affected by a's count
    expect((await b.client.rpc("create_run", { p_id: freshRunId(), p_topic: "x" })).error).toBeNull();
  });

  it("limits how many kits one account registers, and says beforehand whether there is room", async () => {
    expect((await a.client.rpc("library_room", { p_what: "brand_kits" })).data).toBe(true);
    const made = await Promise.all(Array.from({ length: 21 }, (_, i) => a.client.rpc("register_brand_kit", { p_slug: `kit-${i}`, p_name: `Kit ${i}` })));
    expect(made.filter((r) => !r.error)).toHaveLength(20);
    expect(made.filter((r) => r.error).map((r) => r.error!.message)).toEqual(["too_many_brand_kits"]);
    expect((await a.client.rpc("library_room", { p_what: "brand_kits" })).data).toBe(false);
    // renaming one of its own is not one more
    const kept = (await a.client.from("brand_kits").select("slug").limit(1).single()).data!.slug as string;
    expect((await a.client.rpc("register_brand_kit", { p_slug: kept, p_name: "Renamed" })).error).toBeNull();
    expect((await b.client.rpc("library_room", { p_what: "brand_kits" })).data).toBe(true);
    expect((await a.client.rpc("library_room", { p_what: "everything" })).error?.message).toBe("invalid_kind");
    // a kit's name may be as long as the studio makes them
    expect((await b.client.rpc("register_brand_kit", { p_slug: "a".repeat(48), p_name: "Long" })).error).toBeNull();
  });

  it("follows an account's address when it changes, so credit goes to whoever signs in with it now", async () => {
    const moved = `moved-${a.id.slice(0, 8)}@example.test`;
    expect((await service().auth.admin.updateUserById(a.id, { email: moved, email_confirm: true })).error).toBeNull();
    expect((await service().rpc("grant_credit", { p_email: a.email, p_amount_usd: 1 })).error?.message).toBe("not_found");
    expect((await service().rpc("grant_credit", { p_email: `  ${moved.toUpperCase()} `, p_amount_usd: 1 })).data).toBe(1);
    expect(await balance(a)).toBe(1);
    expect((await service().rpc("grant_credit", { p_email: "", p_amount_usd: 1 })).error?.message).toBe("not_found");
  });

  it("grants credit by email, and only to an account that exists", async () => {
    expect((await service().rpc("grant_credit", { p_email: a.email.toUpperCase(), p_amount_usd: 3.5, p_note: "welcome" })).data).toBe(3.5);
    expect((await service().rpc("grant_credit", { p_email: "nobody@example.test", p_amount_usd: 1 })).error?.message).toBe("not_found");
    expect(await balance(a)).toBe(3.5);
    expect(await balance(b)).toBe(0);
  });

  it("gives each user their own brand kits and tracks under the same names", async () => {
    for (const u of [a, b]) {
      expect((await u.client.rpc("register_brand_kit", { p_slug: "main", p_name: `${u.email}'s kit` })).error).toBeNull();
      expect((await u.client.rpc("register_track", { p_id: "bed", p_name: "Bed", p_bytes: 1234 })).error).toBeNull();
    }
    expect((await a.client.from("brand_kits").select("slug,name")).data).toEqual([{ slug: "main", name: `${a.email}'s kit` }]);
    await a.client.rpc("remove_brand_kit", { p_slug: "main" });
    await a.client.rpc("remove_track", { p_id: "bed" });
    expect((await a.client.from("brand_kits").select("slug")).data).toEqual([]);
    expect((await service().from("brand_kits").select("user_id").in("user_id", both())).data).toEqual([{ user_id: b.id }]);
    expect((await service().from("music_tracks").select("user_id").in("user_id", both())).data).toEqual([{ user_id: b.id }]);
  });

  it("refuses a run id that is taken, whoever took it", async () => {
    await run(a, RUN_A);
    expect((await a.client.rpc("create_run", { p_id: RUN_A, p_topic: "again" })).error?.message).toBe("run_exists");
    expect((await b.client.rpc("create_run", { p_id: RUN_A, p_topic: "mine now" })).error?.message).toBe("run_exists");
    expect((await b.client.rpc("create_run", { p_id: "not-a-run-id", p_topic: "x" })).error).not.toBeNull();
  });
});
