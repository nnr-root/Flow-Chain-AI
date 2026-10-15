import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as channelsRoute } from "@/app/api/channels/route";
import { DELETE as unlinkRoute } from "@/app/api/channels/[id]/route";
import { GET as postsRoute, POST as publishRoute } from "@/app/api/runs/[id]/publish/route";
import { POST as createSeries } from "@/app/api/series/route";
import { PATCH as changeSeries } from "@/app/api/series/[id]/route";
import { GET as callbackRoute } from "@/app/auth/youtube/callback/route";
import { GET as consentRoute } from "@/app/auth/youtube/route";
import { closeQueue } from "@/server/jobs/queue";
import { freshRunId, localDb, newUser, serviceClient, type TestUser } from "../../test/helpers/db";
import { draftManifest, finishedManifest, params, until, useStudio } from "./helpers";
import { hasRedisServer, startRedis, startWorkerProcess, type TestRedis, type TestWorker } from "./redis";
import { as, cookiesFrom, cookiesOf, saveRunFor, withAccounts } from "./tenant";
import { type FakeYouTube, startYouTube } from "./youtube";

/*
 * Publishing to a user's own channel, end to end (phase 6 spec §6, §10): the studio's own routes, the real worker
 * in its own process, the local database, a throwaway Redis, and a stand-in for Google and YouTube. Skipped
 * without the database or `redis-server`. Nothing here can reach Google.
 */
const supa = localDb();
const studio = useStudio();
let redis: TestRedis;
let admin: Redis;
let youtube: FakeYouTube;
let workers: TestWorker[] = [];
const KEY = Buffer.alloc(32, 11).toString("base64");

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
  await youtube?.stop();
  delete process.env.YOUTUBE_CLIENT_ID;
});

describe.skipIf(!supa || !hasRedisServer())("publishing to a user's own channel", () => {
  const s = supa!;
  const db = () => serviceClient(s);
  let a: TestUser;
  let b: TestUser;
  let aCookie: string;
  let bCookie: string;

  const folder = (u: TestUser) => join(studio.runs, u.id);
  const worker = async (env: Record<string, string> = {}): Promise<TestWorker> => {
    const w = startWorkerProcess({
      REDIS_URL: redis.url, FLOWCHAIN_ROOT: studio.root, RUNS_DIR: studio.runs, FLOWCHAIN_CLI: process.env.FLOWCHAIN_CLI!,
      DATABASE_URL: s.worker, WORKER_RECONCILE_MS: "1000", WORKER_SERIES_MS: "400", WORKER_RECONCILE_KNOWN_USERS_ONLY: "1",
      YOUTUBE_CLIENT_ID: "yt-id", YOUTUBE_CLIENT_SECRET: "yt-secret", CHANNEL_KEY: KEY, GOOGLE_TOKEN_URL: `${youtube.url}/token`, YOUTUBE_API_BASE: youtube.url,
      GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c", RUNPOD_VOICE_ENDPOINT: "ep-v", R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s",
      ...env,
    });
    workers.push(w);
    await until(() => w.output().includes("ready") || w.child.exitCode !== null);
    return w;
  };
  /** The whole visit to the consent page, as a browser makes it: there, and back with what the "platform" hands out. */
  const connect = async (cookie: string, opts: Parameters<FakeYouTube["consent"]>[1] = {}, tamper: { state?: string; back?: string; error?: string } = {}) => {
    const there = await consentRoute(as(cookie, "/auth/youtube"), undefined);
    expect(there.status).toBe(302);
    const asked = new URL(there.headers.get("location")!);
    const jar = cookiesFrom(there, cookie);
    const code = youtube.consent(asked.searchParams.get("code_challenge")!, opts);
    const query = tamper.error ? `error=${tamper.error}&state=${asked.searchParams.get("state")}` : `code=${code}&state=${tamper.state ?? asked.searchParams.get("state")}`;
    const back = await callbackRoute(as(tamper.back ?? jar, `/auth/youtube/callback?${query}`), undefined);
    return { asked, note: new URL(back.headers.get("location")!).searchParams.get("channel"), status: back.status };
  };
  const channels = async (cookie: string) => ((await (await channelsRoute(as(cookie, "/api/channels"), undefined)).json()) as { channels: Array<{ id: string; title: string }> }).channels;
  /** A finished video of the user's, on disk and in the database. */
  const finished = async (u: TestUser, bytes = 2048) => {
    const id = freshRunId();
    const { error } = await u.client.rpc("create_run", { p_id: id, p_topic: "foxes at night" });
    if (error) throw new Error(error.message);
    const dir = await saveRunFor(studio, u, finishedManifest(id));
    await writeFile(join(dir, "final.mp4"), Buffer.alloc(bytes, 1));
    return id;
  };
  const publish = (cookie: string, runId: string, channelId: string) => publishRoute(as(cookie, `/api/runs/${runId}/publish`, { json: { channelId } }), params({ id: runId }));
  const posts = async (cookie: string, runId: string) => ((await (await postsRoute(as(cookie, `/api/runs/${runId}/publish`), params({ id: runId }))).json()) as { posts: Array<{ status: string; url: string | null; error: string | null }> }).posts;

  beforeEach(async () => {
    await admin.flushall();
    process.env.REDIS_URL = redis.url;
    process.env.YOUTUBE_CLIENT_ID = "yt-id";
    withAccounts(s);
    youtube = await startYouTube();
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
    [aCookie, bCookie] = await Promise.all([cookiesOf(s, a), cookiesOf(s, b)]);
    await Promise.all([mkdir(folder(a), { recursive: true }), mkdir(folder(b), { recursive: true })]);
  });

  it("connects a user's channel on the platform's consent page; the web app never holds what comes back", async () => {
    await worker();
    const { asked, note } = await connect(aCookie);
    expect(note).toBe("connected");
    // what was asked of the user: to upload and to say which channel, for a permission that lasts
    expect(asked.origin + asked.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(asked.searchParams.get("client_id")).toBe("yt-id");
    expect(asked.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly");
    expect(asked.searchParams.get("access_type")).toBe("offline");
    expect(asked.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3131/auth/youtube/callback");
    expect(asked.search).not.toContain("yt-secret");
    // the code was exchanged by the worker, with the client's secret and the verifier this browser's request made
    expect(youtube.tokens).toHaveLength(1);
    expect(youtube.tokens[0]).toMatchObject({ grant_type: "authorization_code", client_id: "yt-id", client_secret: "yt-secret", redirect_uri: "http://127.0.0.1:3131/auth/youtube/callback" });
    // the user sees their channel by name; the token is in the database sealed, and nowhere in what the web app answers
    expect(await channels(aCookie)).toEqual([expect.objectContaining({ title: "Test channel" })]);
    expect(await channels(bCookie)).toEqual([]);
    const row = (await db().from("channels").select("user_id,external_id,token").eq("user_id", a.id).single()).data as { token: Buffer; external_id: string };
    expect(row.external_id).toMatch(/^UC-/);
    expect(Buffer.from(row.token).toString("latin1")).not.toContain("rt-code");
    expect(JSON.stringify(await channels(aCookie))).not.toMatch(/rt-|at-|token/);
  });

  it("connects nothing when the answer is not this browser's, not this user's, refused, or without a lasting permission", async () => {
    await worker();
    expect((await connect(aCookie, {}, { state: "x".repeat(43) })).note).toBe("incomplete");
    // another signed-in user arrives with the first one's pending consent: it was begun for someone else
    const there = await consentRoute(as(aCookie, "/auth/youtube"), undefined);
    const state = new URL(there.headers.get("location")!).searchParams.get("state")!;
    const pending = cookiesFrom(there, aCookie).split("; ").find((c) => c.startsWith("fc_oauth="))!;
    const back = await callbackRoute(as(`${bCookie}; ${pending}`, `/auth/youtube/callback?code=whatever&state=${state}`), undefined);
    expect(new URL(back.headers.get("location")!).searchParams.get("channel")).toBe("incomplete");
    expect((await connect(aCookie, {}, { error: "access_denied" })).note).toBe("cancelled");
    expect((await connect(aCookie, { refresh: false })).note).toBe("failed");
    expect((await connect(aCookie, { scope: "https://www.googleapis.com/auth/youtube.readonly" })).note).toBe("failed");
    expect((await connect(aCookie, { channel: null })).note).toBe("failed");
    expect(await channels(aCookie)).toEqual([]);
    expect(await channels(bCookie)).toEqual([]);
    expect((await db().from("channels").select("id").eq("user_id", a.id)).data).toEqual([]);
    // and without a session there is no way in at all
    expect((await consentRoute(new Request("http://127.0.0.1:3131/auth/youtube", { headers: { host: "127.0.0.1:3131" } }), undefined)).status).toBe(401);
  });

  it("publishes a user's finished video to their channel in their name, once", async () => {
    await worker();
    await connect(aCookie);
    const [channel] = await channels(aCookie);
    const runId = await finished(a, 4096);
    expect((await publish(aCookie, runId, channel.id)).status).toBe(202);
    await until(async () => (await posts(aCookie, runId))[0]?.status === "posted", 20_000);
    const [post] = await posts(aCookie, runId);
    expect(post.url).toMatch(/^https:\/\/www\.youtube\.com\/shorts\/vid\d{8}$/);
    // what went to the platform: this video's bytes, under its own title, with a token made from the user's own consent
    expect(youtube.uploads).toHaveLength(1);
    expect(youtube.uploads[0]).toMatchObject({ bytes: 4096 });
    expect(youtube.uploads[0].meta.snippet?.title).toBe(finishedManifest(runId).script!.title);
    // posted with the hashtags its script was written with (phase 7 spec §18), and the one that says it is a short
    expect(youtube.uploads[0].meta.snippet?.description).toBe("#wildlife #foxes #redfox #nightanimals #animalfacts #Shorts");
    expect((youtube.uploads[0].meta.snippet as { tags?: string[] }).tags).toEqual(["wildlife", "foxes", "redfox", "nightanimals", "animalfacts"]);
    expect(youtube.uploads[0].meta.status).toMatchObject({ privacyStatus: "public", selfDeclaredMadeForKids: false });
    expect(youtube.tokens.at(-1)).toMatchObject({ grant_type: "refresh_token", client_secret: "yt-secret" });
    expect(youtube.tokens.at(-1)!.refresh_token).toMatch(/^rt-code-/);
    // asked again, nothing more is sent
    expect((await publish(aCookie, runId, channel.id)).status).toBe(400);
    await new Promise((r) => setTimeout(r, 800));
    expect(youtube.uploads).toHaveLength(1);
  });

  it("publishes nothing across users: someone else's video or channel does not exist", async () => {
    await worker();
    await connect(aCookie);
    await connect(bCookie);
    const [[aChannel], [bChannel]] = [await channels(aCookie), await channels(bCookie)];
    const [aRun, bRun] = [await finished(a), await finished(b)];
    expect((await publish(bCookie, aRun, bChannel.id)).status).toBe(404);
    expect((await publish(bCookie, bRun, aChannel.id)).status).toBe(404);
    expect((await unlinkRoute(as(bCookie, `/api/channels/${aChannel.id}`, { method: "DELETE", json: {} }), params({ id: aChannel.id }))).status).toBe(404);
    expect(await posts(bCookie, aRun)).toEqual([]);
    await new Promise((r) => setTimeout(r, 600));
    expect(youtube.uploads).toEqual([]);
    expect(await channels(aCookie)).toHaveLength(1);
  });

  it("says in its own words why a video could not be published, and tries again only when asked", async () => {
    await worker();
    await connect(aCookie);
    const [channel] = await channels(aCookie);
    const runId = await finished(a);
    youtube.refuseNext = 403;
    await publish(aCookie, runId, channel.id);
    await until(async () => (await posts(aCookie, runId))[0]?.status === "failed", 20_000);
    const [failed] = await posts(aCookie, runId);
    expect(failed.error).toBe("YouTube refused the upload (the day's uploads may be used up). Try again tomorrow.");
    expect(JSON.stringify(failed)).not.toMatch(/quota|exceeded/i);
    await new Promise((r) => setTimeout(r, 1200));
    expect(youtube.uploads).toEqual([]);
    // the user asks again: now it goes
    expect((await publish(aCookie, runId, channel.id)).status).toBe(202);
    await until(async () => (await posts(aCookie, runId))[0]?.status === "posted", 20_000);
    // a consent the user has withdrawn at Google: said, and nothing sent
    const other = await finished(a);
    youtube.revoked.add(youtube.tokens.find((t) => t.grant_type === "refresh_token")!.refresh_token);
    await publish(aCookie, other, channel.id);
    await until(async () => (await posts(aCookie, other))[0]?.status === "failed", 20_000);
    expect((await posts(aCookie, other))[0].error).toBe("The channel is no longer connected. Connect it again on your account page.");
    expect(youtube.uploads).toHaveLength(1);
  });

  it("carries out a post whose job never arrived, and one of a series that does not ask to be shown first; a series that does waits for its owner", async () => {
    await connectWithWorkerThenStop();
    const [channel] = await channels(aCookie);
    // asked for while no worker is there: it is on record, and is not refused
    const waiting = await finished(a);
    expect((await publish(aCookie, waiting, channel.id)).status).toBe(202);
    expect((await posts(aCookie, waiting))[0].status).toBe("queued");
    await db().query("update public.posts set created_at = now() - interval '5 minutes' where run_id = $1", [waiting]);

    // two series: one publishes by itself, one shows its owner each video first
    const { error: credit } = await db().rpc("grant_credit", { p_email: a.email, p_amount_usd: 5 });
    expect(credit).toBeFalsy();
    await writeFile(join(folder(a), "_draft-manifest.json"), JSON.stringify(draftManifest("20261010-000000-000000")));
    await writeFile(join(folder(a), "_plan.json"), JSON.stringify({ items: [], totalUsd: 0.2 }));
    await writeFile(join(folder(a), "_behave.json"), JSON.stringify({ spendUsd: 0.1, makesVideo: true }));
    const series = async (reviewFirst: boolean) => {
      const made = await createSeries(as(aCookie, "/api/series", { json: { name: reviewFirst ? "Shown first" : "By itself", premise: "Foxes", recipe: {} } }), undefined);
      const { id } = (await made.json()) as { id: string };
      expect((await changeSeries(as(aCookie, `/api/series/${id}`, { json: { publishing: { channelId: channel.id, reviewFirst } }, method: "PATCH" }), params({ id }))).status).toBe(200);
      expect((await changeSeries(as(aCookie, `/api/series/${id}`, { json: { schedule: { cadence: "daily" } }, method: "PATCH" }), params({ id }))).status).toBe(200);
      return id;
    };
    const [auto, shown] = [await series(false), await series(true)];
    await worker();
    const runOf = async (id: string) => ((await db().from("runs").select("id").eq("series_id", id)).data ?? [])[0]?.id as string | undefined;
    const made = async (id: string) => {
      const run = await runOf(id);
      return !!run && existsSync(join(folder(a), run, "final.mp4")) && (await db().from("series").select("current_run").eq("id", id).single()).data!.current_run === null;
    };
    await until(async () => (await made(auto)) && (await made(shown)), 40_000);
    await until(async () => (await posts(aCookie, (await runOf(auto))!))[0]?.status === "posted" && (await posts(aCookie, waiting))[0]?.status === "posted", 30_000);
    // the one that asks to be shown first has posted nothing: its owner presses Publish
    expect(await posts(aCookie, (await runOf(shown))!)).toEqual([]);
    expect(youtube.uploads).toHaveLength(2);
    expect((await publish(aCookie, (await runOf(shown))!, channel.id)).status).toBe(202);
    await until(async () => (await posts(aCookie, (await runOf(shown))!))[0]?.status === "posted", 20_000);
    expect(youtube.uploads).toHaveLength(3);
    expect(await readFile(join(folder(a), (await runOf(auto))!, "final.mp4"), "utf8")).toBe("video");
  });

  /** Connects a's channel with a worker that is then stopped, so that what follows begins with nobody listening. */
  async function connectWithWorkerThenStop(): Promise<void> {
    const w = await worker();
    expect((await connect(aCookie)).note).toBe("connected");
    await w.stop();
    workers = [];
  }

  it("does not exist in a studio without a client at the platform", async () => {
    delete process.env.YOUTUBE_CLIENT_ID;
    expect((await consentRoute(as(aCookie, "/auth/youtube"), undefined)).status).toBe(404);
    expect(await channels(aCookie)).toEqual([]);
    expect((await publish(aCookie, freshRunId(), "11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });
});
