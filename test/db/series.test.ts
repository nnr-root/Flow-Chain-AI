import { beforeEach, describe, expect, it } from "vitest";
import { freshRunId, localDb, newUser, serviceClient, type TestUser, visitorDb } from "../helpers/db.js";

/*
 * Series in the database (phase 6 spec §8), against the local Postgres container: each user's client is the web
 * app's own role asking in that user's name. Skipped when the database is not running. Other test files use the
 * same database at the same time: every test here makes its own users and looks only at their rows.
 */
const supa = localDb();
const RECIPE = { aspect: "9:16", scenes: 4, style: "anime" };

describe.skipIf(!supa)("series in the database", () => {
  const s = supa!;
  const service = () => serviceClient(s);
  let a: TestUser;
  let b: TestUser;
  const create = (u: TestUser, name = "Myths", premise = "Greek myths, one god at a time", recipe: unknown = RECIPE) =>
    u.client.rpc("create_series", { p_name: name, p_premise: premise, p_recipe: recipe });
  const made = async (u: TestUser, name?: string) => {
    const { data, error } = await create(u, name);
    if (error) throw new Error(error.message);
    return String(data);
  };

  beforeEach(async () => {
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
  });

  it("keeps a series for the user who made it, and shows it to nobody else", async () => {
    const id = await made(a);
    expect((await a.client.from("series").select("id,name,premise,recipe")).data).toEqual([{ id, name: "Myths", premise: "Greek myths, one god at a time", recipe: RECIPE }]);
    expect((await b.client.from("series").select("id")).data).toEqual([]);
    // someone who is not signed in sees nothing, and can make nothing
    expect((await visitorDb(s).from("series").select("id")).data ?? []).toEqual([]);
    expect((await visitorDb(s).rpc("create_series", { p_name: "x", p_premise: "y", p_recipe: RECIPE })).error?.message).toBe("unauthenticated");
  });

  it("refuses a series without a name or a premise, one too long, and a recipe that is not an object or is huge", async () => {
    for (const [name, premise, recipe] of [["", "p", RECIPE], ["  ", "p", RECIPE], ["n", "", RECIPE], ["n".repeat(81), "p", RECIPE], ["n", "p".repeat(301), RECIPE], ["n", "p", "[1, 2]"], ["n", "p", { blob: "x".repeat(60_000) }]] as const) {
      expect((await create(a, name, premise, recipe)).error?.message, JSON.stringify([name.slice(0, 5), premise.slice(0, 5)])).toBe("invalid_series");
    }
    expect((await a.client.from("series").select("id")).data).toEqual([]);
  });

  it("refuses every direct write: a series is made, changed and removed only through its functions", async () => {
    const id = await made(a);
    await expect(a.client.query("insert into public.series (user_id, name, premise, recipe) values ($1, 'x', 'y', '{}')", [a.id])).rejects.toThrow(/permission denied/);
    await expect(a.client.query("update public.series set name = 'theirs', user_id = $2 where id = $1", [id, b.id])).rejects.toThrow(/permission denied/);
    await expect(a.client.query("delete from public.series where id = $1", [id])).rejects.toThrow(/permission denied/);
    expect((await service().from("series").select("name,user_id").eq("id", id).single()).data).toEqual({ name: "Myths", user_id: a.id });
  });

  it("lets an account have twenty series and not one more, also when asked for all at once", async () => {
    const answers = await Promise.all(Array.from({ length: 24 }, (_x, i) => create(a, `Series ${i}`)));
    expect(answers.filter((r) => !r.error)).toHaveLength(20);
    expect(new Set(answers.filter((r) => r.error).map((r) => r.error!.message))).toEqual(new Set(["too_many_series"]));
    // someone else's count is their own
    expect((await create(b)).error).toBeFalsy();
  });

  it("ties a run to the caller's own series, and to nobody else's", async () => {
    const id = await made(a);
    const run = freshRunId();
    expect((await a.client.rpc("create_series_run", { p_series_id: id, p_id: run, p_topic: "Zeus" })).error).toBeFalsy();
    expect((await a.client.from("runs").select("id,series_id,topic").eq("id", run)).data).toEqual([{ id: run, series_id: id, topic: "Zeus" }]);
    // b cannot put a run into a's series: for b it does not exist, and no run is left behind by the attempt
    const theirs = freshRunId();
    expect((await b.client.rpc("create_series_run", { p_series_id: id, p_id: theirs, p_topic: "x" })).error?.message).toBe("not_found");
    expect((await service().from("runs").select("id").eq("id", theirs)).data).toEqual([]);
    // the run's own limits still hold: an id that is taken is refused as it is for any run
    expect((await a.client.rpc("create_series_run", { p_series_id: id, p_id: run, p_topic: "again" })).error?.message).toBe("run_exists");
  });

  it("removes a series for its owner only, and leaves its videos, no longer in a series", async () => {
    const id = await made(a);
    const run = freshRunId();
    await a.client.rpc("create_series_run", { p_series_id: id, p_id: run, p_topic: "Hera" });
    expect((await b.client.rpc("remove_series", { p_id: id })).error?.message).toBe("not_found");
    expect((await a.client.from("series").select("id")).data).toEqual([{ id }]);
    expect((await a.client.rpc("remove_series", { p_id: id })).error).toBeFalsy();
    expect((await a.client.from("series").select("id")).data).toEqual([]);
    expect((await a.client.from("runs").select("id,series_id").eq("id", run)).data).toEqual([{ id: run, series_id: null }]);
    // and once more is refused: it is gone
    expect((await a.client.rpc("remove_series", { p_id: id })).error?.message).toBe("not_found");
  });

  describe("a series that makes its videos by itself", () => {
    const worker = () => serviceClient(s);
    const grant = async (u: TestUser, usd: number) => {
      const { error } = await worker().rpc("grant_credit", { p_email: u.email, p_amount_usd: usd, p_note: "test" });
      if (error) throw new Error(error.message);
    };
    const balance = async (u: TestUser) => Number((await worker().from("users").select("balance_usd").eq("id", u.id).single()).data!.balance_usd);
    const schedule = (u: TestUser, id: string, cadence: string | null = "daily") => u.client.rpc("set_series_schedule", { p_id: id, p_cadence: cadence });
    const start = (id: string, run = freshRunId(), draft = 0.02) => worker().rpc("start_series_episode", { p_series_id: id, p_run_id: run, p_topic: "t", p_draft_cap_usd: draft }).then((r) => ({ ...r, run }));
    const hold = (id: string, run: string, cap: number) => worker().rpc("reserve_for_series", { p_series_id: id, p_run_id: run, p_cap_usd: cap });
    const settle = (reservation: unknown, total: number) => worker().rpc("settle", { p_reservation_id: reservation, p_run_total_usd: total });
    const finish = (id: string, run: string, pause: string | null = null) => worker().rpc("finish_series_episode", { p_series_id: id, p_run_id: run, p_pause: pause });
    const row = async (id: string) => (await worker().from("series").select("cadence,status,paused_reason,current_run,current_step,next_due_at").eq("id", id).single()).data!;
    /** One whole video: the script held and settled, the rest held and settled, the series free again. */
    const video = async (id: string, cap: number, spent: number) => {
      const began = await start(id);
      if (began.error) return began.error.message;
      await settle(began.data, 0.01);
      const held = await hold(id, began.run, cap);
      if (held.error) return held.error.message;
      await settle(held.data, spent);
      await finish(id, began.run);
      return "made";
    };
    const due = (id: string) => worker().query("update public.series set next_due_at = now() - interval '1 minute' where id = $1", [id]);

    it("takes a schedule that is one of the four, without any amount, and only from the series' owner", async () => {
      const id = await made(a);
      for (const cadence of ["hourly", "", null]) expect((await schedule(a, id, cadence)).error?.message, String(cadence)).toBe("invalid_schedule");
      expect((await schedule(b, id)).error?.message).toBe("not_found");
      expect((await row(id)).cadence).toBe("manual");
      expect((await schedule(a, id)).error).toBeFalsy();
      expect(await row(id)).toMatchObject({ cadence: "daily", status: "active", paused_reason: null });
      expect(new Date(String((await row(id)).next_due_at)).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      // there is no limit for a video or a month to give or to keep: the columns and the old function are gone
      expect((await a.client.rpc("set_series_schedule", { p_id: id, p_cadence: "daily", p_per_video_cap_usd: 0.5, p_monthly_budget_usd: 2 })).error).toBeTruthy();
      expect((await worker().query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'series' and column_name in ('per_video_cap_usd', 'monthly_budget_usd')"))).toEqual([]);
      // taking the schedule away takes the approval with it
      expect((await schedule(a, id, "manual")).error).toBeFalsy();
      expect(await row(id)).toMatchObject({ cadence: "manual", next_due_at: null });
    });

    it("keeps the functions that spend for the worker: a user can start no episode and hold nothing in a series' name", async () => {
      const id = await made(a);
      await schedule(a, id);
      await grant(a, 5);
      for (const [name, args] of [
        ["start_series_episode", { p_series_id: id, p_run_id: freshRunId(), p_topic: "t", p_draft_cap_usd: 0.02 }],
        ["reserve_for_series", { p_series_id: id, p_run_id: freshRunId(), p_cap_usd: 0.1 }],
        ["finish_series_episode", { p_series_id: id, p_run_id: freshRunId(), p_pause: null }],
      ] as const) {
        for (const who of [a.client, b.client, visitorDb(s)]) expect((await who.rpc(name, args)).error?.message, name).toMatch(/permission denied/);
      }
      expect(await balance(a)).toBe(5);
      expect((await row(id)).current_run).toBeNull();
    });

    it("makes a video for a series with a schedule: the script's cost and then the rest are held from the owner's credit, and what is not spent comes back", async () => {
      const id = await made(a);
      await schedule(a, id, "daily");
      await grant(a, 5);
      const began = await start(id);
      expect(began.error).toBeFalsy();
      expect(await balance(a)).toBe(4.98);
      expect(await row(id)).toMatchObject({ current_run: began.run, current_step: "draft" });
      expect((await a.client.from("runs").select("series_id,user_id").eq("id", began.run).single()).data).toEqual({ series_id: id, user_id: a.id });
      // the next is due an interval from now, and until this one is done no other is begun
      expect(new Date(String((await row(id)).next_due_at)).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      await due(id);
      expect((await start(id)).error?.message).toBe("busy");
      await settle(began.data, 0.006);
      expect(await balance(a)).toBe(4.994);
      // the rest: only for the video it is making, only once, and never more than its owner has
      expect((await hold(id, freshRunId(), 0.3)).error?.message).toBe("not_current");
      expect((await hold(id, began.run, 5)).error?.message).toBe("insufficient_credit");
      expect(await row(id)).toMatchObject({ current_step: "draft" });
      const held = await hold(id, began.run, 0.3);
      expect(held.error).toBeFalsy();
      expect(await balance(a)).toBe(4.694);
      expect((await hold(id, began.run, 0.1)).error?.message).toBe("not_current");
      expect(await row(id)).toMatchObject({ current_step: "generate" });
      await settle(held.data, 0.2);
      await finish(id, began.run);
      expect(await balance(a)).toBe(4.8);
      expect(await row(id)).toMatchObject({ current_run: null, current_step: null, status: "active" });
    });

    it("begins nothing that is not due, not active, or someone's manual series", async () => {
      const id = await made(a);
      await grant(a, 5);
      expect((await start(id)).error?.message).toBe("not_active");
      await schedule(a, id);
      await worker().query("update public.series set next_due_at = now() + interval '1 hour' where id = $1", [id]);
      expect((await start(id)).error?.message).toBe("not_due");
      await due(id);
      await a.client.rpc("set_series_status", { p_id: id, p_active: false });
      expect((await start(id)).error?.message).toBe("not_active");
      expect(await row(id)).toMatchObject({ status: "paused", paused_reason: "user" });
      // only its owner lets it go on; then it is due at once
      expect((await b.client.rpc("set_series_status", { p_id: id, p_active: true })).error?.message).toBe("not_found");
      await a.client.rpc("set_series_status", { p_id: id, p_active: true });
      expect((await start(id)).error).toBeFalsy();
      expect(await balance(a)).toBe(4.98);
    });

    it("goes on making videos for as long as its owner's credit covers them, with no limit of its own, and holds nothing once it does not", async () => {
      const id = await made(a);
      await schedule(a, id, "daily2");
      await grant(a, 1);
      // two videos at 0.40 each (their scripts included) leave 0.20
      for (let i = 0; i < 2; i++) {
        await due(id);
        expect(await video(id, 0.5, 0.4)).toBe("made");
      }
      expect(await balance(a)).toBeCloseTo(0.2, 4);
      await due(id);
      const third = await start(id);
      expect(third.error).toBeFalsy();
      await settle(third.data, 0.01);
      // 0.19 is left: 0.2 is not there to hold, and what is refused holds nothing and moves nothing
      expect((await hold(id, third.run, 0.2)).error?.message).toBe("insufficient_credit");
      expect(await balance(a)).toBeCloseTo(0.19, 4);
      expect(await row(id)).toMatchObject({ current_run: third.run, current_step: "draft", status: "active" });
      // the worker stops the series for that reason, and no other reason of the old limits is one it can give
      for (const gone of ["budget", "cap"]) expect((await finish(id, third.run, gone)).error?.message).toBe("invalid_reason");
      expect((await finish(id, third.run, "credit")).error).toBeFalsy();
      expect(await row(id)).toMatchObject({ current_run: null, status: "paused", paused_reason: "credit" });
      await due(id);
      expect((await start(id)).error?.message).toBe("not_active");
      expect((await worker().from("runs").select("id").eq("series_id", id)).data).toHaveLength(3);
    });

    it("refuses what the owner's credit does not cover, and leaves no run behind", async () => {
      const id = await made(a);
      await schedule(a, id, "daily");
      await grant(a, 0.01);
      const began = await start(id);
      expect(began.error?.message).toBe("insufficient_credit");
      expect((await worker().from("runs").select("id").eq("id", began.run)).data).toEqual([]);
      expect(await row(id)).toMatchObject({ current_run: null, status: "active" });
      expect(await balance(a)).toBe(0.01);
      // the worker then stops the series and says why; its owner sees the reason
      const run = freshRunId();
      expect((await finish(id, run, "credit")).error).toBeFalsy();
      expect((await a.client.from("series").select("status,paused_reason").eq("id", id).single()).data).toEqual({ status: "paused", paused_reason: "credit" });
      expect((await finish(id, run, "because")).error?.message).toBe("invalid_reason");
    });

    it("cannot be raced: of many holds or starts asked for at once, one is made", async () => {
      const id = await made(a);
      await schedule(a, id, "daily");
      await grant(a, 20);
      const began = await start(id);
      await settle(began.data, 0.01);
      const answers = await Promise.all(Array.from({ length: 12 }, () => hold(id, began.run, 0.6)));
      expect(answers.filter((r) => !r.error)).toHaveLength(1);
      expect(new Set(answers.filter((r) => r.error).map((r) => r.error!.message))).toEqual(new Set(["not_current"]));
      expect(await balance(a)).toBeCloseTo(20 - 0.01 - 0.6, 4);
      // and starting: asked for many times at once, one episode begins
      const other = await made(a, "Second");
      await schedule(a, other, "daily");
      const starts = await Promise.all(Array.from({ length: 8 }, () => start(other)));
      expect(starts.filter((r) => !r.error)).toHaveLength(1);
      expect(new Set(starts.filter((r) => r.error).map((r) => r.error!.message))).toEqual(new Set(["busy"]));
      expect((await worker().from("runs").select("id").eq("series_id", other)).data).toHaveLength(1);
    });

    it("asks in the owner's name for that one call only: whoever asks next is still themselves", async () => {
      const id = await made(a);
      await schedule(a, id);
      await grant(a, 5);
      // one transaction of the worker's: a series' episode is begun, and after it the worker is nobody again
      const began = freshRunId();
      const rows = await worker().query<{ held: string | null; who: string | null }>("select public.start_series_episode($1, $2, 't', 0.02) as held, auth.uid() as who", [id, began]);
      expect(rows[0].held).toBeTruthy();
      expect(rows[0].who).toBeNull();
      // a refusal inside gives the name back as well: the statement fails, and the next is nobody's again
      await expect(worker().query("select public.start_series_episode($1, $2, 't', 0.02)", [id, freshRunId()])).rejects.toThrow(/busy/);
      expect((await worker().query<{ who: string | null }>("select auth.uid() as who"))[0].who).toBeNull();
    });
  });
});
