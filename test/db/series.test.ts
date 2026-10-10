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
});
