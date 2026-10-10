import { beforeEach, describe, expect, it } from "vitest";
import { freshRunId, localDb, newUser, serviceClient, type TestUser, visitorDb } from "../helpers/db.js";

/*
 * Publishing in the database (phase 6 spec §6, §10), against the local Postgres container: each user's client is
 * the web app's own role asking in that user's name; "the worker" is the worker's role. Skipped when the
 * database is not running. Every test makes its own users and looks only at their rows.
 */
const supa = localDb();
const SEALED = Buffer.alloc(64, 9);

describe.skipIf(!supa)("publishing in the database", () => {
  const s = supa!;
  const worker = () => serviceClient(s);
  let a: TestUser;
  let b: TestUser;
  const link = async (u: TestUser, external = "UC-one", title = "My channel", token: Buffer = SEALED) => {
    const { data, error } = await worker().rpc("link_channel", { p_user_id: u.id, p_provider: "youtube", p_external_id: external, p_title: title, p_token: token });
    if (error) throw new Error(error.message);
    return String(data);
  };
  const run = async (u: TestUser) => {
    const id = freshRunId();
    const { error } = await u.client.rpc("create_run", { p_id: id, p_topic: "t" });
    if (error) throw new Error(error.message);
    return id;
  };
  const series = async (u: TestUser) => String((await u.client.rpc("create_series", { p_name: "S", p_premise: "p", p_recipe: {} })).data);
  const post = async (id: unknown) => (await worker().from("posts").select("status,external_id,url,error,user_id").eq("id", id).single()).data!;

  beforeEach(async () => {
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
  });

  it("keeps a channel's token where the web app cannot read it: a user learns that a channel is connected and what it is called", async () => {
    const id = await link(a);
    expect((await a.client.rpc("my_channels", {})).data).toEqual([expect.objectContaining({ id, provider: "youtube", title: "My channel" })]);
    const [shown] = (await a.client.rpc("my_channels", {})).data as Array<Record<string, unknown>>;
    expect(Object.keys(shown).sort()).toEqual(["created_at", "id", "provider", "title"]);
    expect((await b.client.rpc("my_channels", {})).data).toEqual([]);
    expect((await visitorDb(s).rpc("my_channels", {})).data ?? []).toEqual([]);
    // the table itself is shut to the web role, whoever asks and whichever column
    for (const who of [a.client, b.client, visitorDb(s)]) {
      expect((await who.from("channels").select("id")).error?.message).toMatch(/permission denied/);
      await expect(who.query("select token from public.channels")).rejects.toThrow(/permission denied/);
    }
  });

  it("lets only the worker keep a channel, and a user only disconnect their own", async () => {
    for (const who of [a.client, b.client, visitorDb(s)]) {
      expect((await who.rpc("link_channel", { p_user_id: a.id, p_provider: "youtube", p_external_id: "UC-x", p_title: "x", p_token: SEALED })).error?.message).toMatch(/permission denied/);
    }
    const id = await link(a);
    // connected again, the same channel's token is replaced, not doubled
    expect(await link(a, "UC-one", "Renamed", Buffer.alloc(40, 3))).toBe(id);
    expect((await a.client.rpc("my_channels", {})).data).toEqual([expect.objectContaining({ id, title: "Renamed" })]);
    expect((await b.client.rpc("unlink_channel", { p_id: id })).error?.message).toBe("not_found");
    expect((await a.client.rpc("unlink_channel", { p_id: id })).error).toBeFalsy();
    expect((await a.client.rpc("my_channels", {})).data).toEqual([]);
    expect((await worker().from("channels").select("id").eq("id", id)).data).toEqual([]);
  });

  it("allows an account five channels and refuses a sixth", async () => {
    for (let i = 0; i < 5; i++) await link(a, `UC-${i}`);
    await expect(link(a, "UC-6")).rejects.toThrow("too_many_channels");
    // one of the five, connected again, is still welcome
    await expect(link(a, "UC-2")).resolves.toBeTruthy();
    await expect(link(b, "UC-6")).resolves.toBeTruthy();
  });

  it("posts a user's own video to a user's own channel, and nothing across users", async () => {
    const [channel, theirs, mine, other] = [await link(a), await link(b, "UC-b"), await run(a), await run(b)];
    expect((await a.client.rpc("request_post", { p_run_id: other, p_channel_id: channel })).error?.message).toBe("not_found");
    expect((await a.client.rpc("request_post", { p_run_id: mine, p_channel_id: theirs })).error?.message).toBe("not_found");
    expect((await visitorDb(s).rpc("request_post", { p_run_id: mine, p_channel_id: channel })).error?.message).toBe("unauthenticated");
    const asked = await a.client.rpc("request_post", { p_run_id: mine, p_channel_id: channel });
    expect(asked.error).toBeFalsy();
    expect(await post(asked.data)).toMatchObject({ status: "queued", user_id: a.id });
    // a's own rows, and nobody else's
    expect((await a.client.from("posts").select("id,status")).data).toEqual([{ id: asked.data, status: "queued" }]);
    expect((await b.client.from("posts").select("id")).data).toEqual([]);
  });

  it("puts a video on a channel once: asked again while it is on its way or there, nothing more is sent; a failed one is tried again", async () => {
    const [channel, mine] = [await link(a), await run(a)];
    const { data: id } = await a.client.rpc("request_post", { p_run_id: mine, p_channel_id: channel });
    expect((await a.client.rpc("request_post", { p_run_id: mine, p_channel_id: channel })).error?.message).toBe("post_pending");
    // only the worker says what became of it
    expect((await a.client.rpc("record_post", { p_id: id, p_status: "posted", p_external_id: "x", p_url: "https://x", p_error: null })).error?.message).toMatch(/permission denied/);
    expect((await worker().rpc("record_post", { p_id: id, p_status: "failed", p_external_id: null, p_url: null, p_error: "It could not be published." })).error).toBeFalsy();
    expect(await post(id)).toMatchObject({ status: "failed", error: "It could not be published." });
    const again = await a.client.rpc("request_post", { p_run_id: mine, p_channel_id: channel });
    expect(again.data).toBe(id);
    expect(await post(id)).toMatchObject({ status: "queued", error: null });
    await worker().rpc("record_post", { p_id: id, p_status: "posted", p_external_id: "abc123", p_url: "https://www.youtube.com/shorts/abc123", p_error: null });
    expect(await post(id)).toMatchObject({ status: "posted", external_id: "abc123", url: "https://www.youtube.com/shorts/abc123" });
    expect((await a.client.rpc("request_post", { p_run_id: mine, p_channel_id: channel })).error?.message).toBe("already_posted");
    // and what is there is not changed again, whatever is said later
    await worker().rpc("record_post", { p_id: id, p_status: "failed", p_external_id: null, p_url: null, p_error: "late" });
    expect(await post(id)).toMatchObject({ status: "posted", url: "https://www.youtube.com/shorts/abc123" });
    expect((await worker().rpc("record_post", { p_id: id, p_status: "gone", p_external_id: null, p_url: null, p_error: null })).error?.message).toBe("invalid_status");
  });

  it("sends a series' videos only to a channel of its owner, and posts by itself only when the owner does not ask to see each first", async () => {
    const [channel, theirs, id] = [await link(a), await link(b, "UC-b"), await series(a)];
    const publishing = (u: TestUser, ch: string | null, review: boolean) => u.client.rpc("set_series_publishing", { p_id: id, p_channel_id: ch, p_review_first: review });
    expect((await publishing(a, theirs, false)).error?.message).toBe("not_found");
    expect((await publishing(b, channel, false)).error?.message).toBe("not_found");
    const made = freshRunId();
    await a.client.rpc("create_series_run", { p_series_id: id, p_id: made, p_topic: "t" });
    const auto = () => worker().rpc("post_for_series", { p_series_id: id, p_run_id: made });
    for (const who of [a.client, b.client]) expect((await who.rpc("post_for_series", { p_series_id: id, p_run_id: made })).error?.message).toMatch(/permission denied/);
    // no channel: nothing. A channel, shown first (the default): nothing either, the owner presses Publish.
    expect((await auto()).data).toBeNull();
    expect((await publishing(a, channel, true)).error).toBeFalsy();
    expect((await auto()).data).toBeNull();
    // not shown first: the post is made, once
    expect((await publishing(a, channel, false)).error).toBeFalsy();
    const first = await auto();
    expect(await post(first.data)).toMatchObject({ status: "queued", user_id: a.id });
    expect((await auto()).data).toBeNull();
    // and never for a video that is not the series' own
    const stray = await run(a);
    expect((await worker().rpc("post_for_series", { p_series_id: id, p_run_id: stray })).data).toBeNull();
    // a channel that is disconnected takes its posts with it and leaves the series with nowhere to send
    await a.client.rpc("unlink_channel", { p_id: channel });
    expect((await worker().from("posts").select("id").eq("id", first.data)).data).toEqual([]);
    expect((await a.client.from("series").select("channel_id").eq("id", id).single()).data).toEqual({ channel_id: null });
  });
});
