import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listSeries, POST as createSeries } from "@/app/api/series/route";
import { PATCH as changeSeries } from "@/app/api/series/[id]/route";
import { closeQueue } from "@/server/jobs/queue";
import { localDb, newUser, serviceClient, type TestUser } from "../../test/helpers/db";
import { draftManifest, params, until, useStudio } from "./helpers";
import { hasRedisServer, startRedis, startWorkerProcess, type TestRedis, type TestWorker } from "./redis";
import { as, cookiesOf, withAccounts } from "./tenant";

/*
 * A series that makes its videos by itself, end to end (phase 6 spec §4–5): the owner approves a budget through
 * the studio's own routes, and the real worker (its own process, the stand-in CLI) begins the video that is due,
 * prices it, holds credit inside the approval, generates it and settles what it cost. Needs the local database
 * and `redis-server`; skipped without either. Nothing here can reach a provider.
 */
const supa = localDb();
const studio = useStudio();
let redis: TestRedis;
let admin: Redis;
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
});

describe.skipIf(!supa || !hasRedisServer())("a series on a schedule", () => {
  const s = supa!;
  const db = () => serviceClient(s);
  let a: TestUser;
  let cookie: string;

  const folder = () => join(studio.runs, a.id);
  /** What the stand-in CLI does for this user: the script it "writes", what the rest is priced at, and how generating ends. */
  const stage = async (totalUsd: number, behave: Record<string, unknown>) => {
    await mkdir(folder(), { recursive: true });
    await writeFile(join(folder(), "_draft-manifest.json"), JSON.stringify(draftManifest("20261010-000000-000000")));
    await writeFile(join(folder(), "_plan.json"), JSON.stringify({ items: [], totalUsd }));
    await writeFile(join(folder(), "_behave.json"), JSON.stringify(behave));
  };
  const calls = async (): Promise<string[][]> => {
    const file = join(folder(), "_calls.jsonl");
    if (!existsSync(file)) return [];
    return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  };
  const balance = async () => Number((await db().from("users").select("balance_usd").eq("id", a.id).single()).data!.balance_usd);
  const grant = async (usd: number) => {
    const { error } = await db().rpc("grant_credit", { p_email: a.email, p_amount_usd: usd });
    if (error) throw new Error(error.message);
  };
  const row = async (id: string) => (await db().from("series").select("status,paused_reason,current_run,current_step,next_due_at").eq("id", id).single()).data!;
  const runsOf = async (id: string) => ((await db().from("runs").select("id,charged_usd,topic").eq("series_id", id).order("created_at")).data ?? []) as Array<{ id: string; charged_usd: string; topic: string }>;
  const open = async () => (await db().from("reservations").select("id").eq("status", "open").eq("user_id", a.id)).data!.length;
  /** A series made and given a schedule through the studio's own routes, as its owner. */
  const series = async (schedule: Record<string, unknown>, recipe: Record<string, unknown> = {}) => {
    const made = await createSeries(as(cookie, "/api/series", { json: { name: "Foxes", premise: "Foxes at night, one story at a time", recipe } }), undefined);
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const set = await changeSeries(as(cookie, `/api/series/${id}`, { json: { schedule }, method: "PATCH" }), params({ id }));
    expect(set.status).toBe(200);
    return id;
  };
  const worker = async (extraEnv: Record<string, string> = {}): Promise<TestWorker> => {
    const w = startWorkerProcess({
      ...extraEnv,
      REDIS_URL: redis.url, FLOWCHAIN_ROOT: studio.root, RUNS_DIR: studio.runs, FLOWCHAIN_CLI: process.env.FLOWCHAIN_CLI!,
      DATABASE_URL: s.worker, WORKER_RECONCILE_MS: "1000", WORKER_SERIES_MS: "400",
      // other test files use the same database at the same time: this worker leaves their users' credit alone
      WORKER_RECONCILE_KNOWN_USERS_ONLY: "1",
      GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c", RUNPOD_VOICE_ENDPOINT: "ep-v", R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s",
    });
    workers.push(w);
    await until(() => w.output().includes("ready") || w.child.exitCode !== null);
    return w;
  };

  beforeEach(async () => {
    await admin.flushall();
    process.env.REDIS_URL = redis.url;
    withAccounts(s);
    a = await newUser(s, "a");
    cookie = await cookiesOf(s, a);
    // (Other test files' workers, and a developer's own local studio, share this database: a series is driven only
    // by the worker whose disk holds its owner's folder, so they leave these alone and this one leaves theirs.)
  });

  it("begins the video that is due, prices it, generates it inside the approval and settles what it cost; then waits for the next one", async () => {
    await grant(5);
    await stage(0.31, { spendUsd: 0.2, makesVideo: true });
    const id = await series({ cadence: "daily" });
    await worker();
    await until(async () => (await runsOf(id)).length === 1 && (await row(id)).current_run === null && (await open()) === 0, 30_000);
    const [run] = await runsOf(id);
    expect(existsSync(join(folder(), run.id, "final.mp4"))).toBe(true);
    // the two jobs a user's clicks would have queued, in their exact shapes: the script from the built topic, then
    // the rest with the planned price as both its budget and its cap
    const jobs = (await calls()).filter((c) => c[0] !== "plan");
    expect(jobs).toHaveLength(2);
    expect(jobs[0].slice(0, 5)).toEqual(["run", "--draft", "--yes", "--run-id", run.id]);
    expect(jobs[0][jobs[0].indexOf("--topic") + 1]).toBe("Foxes at night, one story at a time. This is the first video of a series.");
    expect(jobs[1]).toEqual(["resume", run.id, "--budget", "0.31", "--cap", "0.31"]);
    expect(run.topic).toBe("Foxes at night, one story at a time. This is the first video of a series.");
    // what it cost is what the run's own ledger says, taken from the owner's credit; nothing is left held
    const spent = Number(run.charged_usd);
    expect(spent).toBeGreaterThanOrEqual(0.2);
    expect(spent).toBeLessThanOrEqual(0.33);
    expect(await balance()).toBeCloseTo(5 - spent, 4);
    // it is still running, and the next video is a day away: nothing more is begun meanwhile
    expect(await row(id)).toMatchObject({ status: "active", paused_reason: null, current_step: null });
    expect(new Date(String((await row(id)).next_due_at)).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await runsOf(id)).toHaveLength(1);
    // its owner sees what it used this month
    const listed = (await (await listSeries(as(cookie, "/api/series"), undefined)).json()) as { series: Array<{ id: string; monthUsd: number; active: boolean; episodes: unknown[] }> };
    expect(listed.series.find((x) => x.id === id)).toMatchObject({ monthUsd: spent, active: true, episodes: [expect.objectContaining({ runId: run.id })] });
  });

  it("does not make a video whose price, once its script is written, is more than its owner has: it stops and says why, with only the script bought", async () => {
    // (there is no limit of the series' own: the same video is made for an owner who has the credit, below)
    await grant(0.5);
    await stage(0.9, { spendUsd: 0.7, makesVideo: true });
    const id = await series({ cadence: "daily" });
    await worker();
    await until(async () => (await row(id)).status === "paused", 30_000);
    expect(await row(id)).toMatchObject({ status: "paused", paused_reason: "credit", current_run: null });
    expect((await calls()).filter((c) => c[0] === "resume")).toEqual([]);
    await until(async () => (await open()) === 0);
    expect(await balance()).toBeGreaterThan(0.5 - 0.021);
    // stopped is stopped: nothing is begun until the owner lets it go on
    await new Promise((r) => setTimeout(r, 1200));
    expect(await runsOf(id)).toHaveLength(1);
  });

  it("makes a video of any price its owner's credit covers: nothing of the series' own stands in the way", async () => {
    await grant(5);
    await stage(0.9, { spendUsd: 0.7, makesVideo: true });
    const id = await series({ cadence: "daily" });
    await worker();
    await until(async () => (await runsOf(id)).length === 1 && (await row(id)).current_run === null && (await open()) === 0, 30_000);
    const [run] = await runsOf(id);
    expect((await calls()).filter((c) => c[0] === "resume")).toEqual([["resume", run.id, "--budget", "0.9", "--cap", "0.9"]]);
    expect(await row(id)).toMatchObject({ status: "active", paused_reason: null });
    expect(await balance()).toBeLessThan(5 - 0.7 + 0.0001);
  });

  it("stops when the owner's credit does not cover the next video, and begins nothing", async () => {
    await stage(0.31, { spendUsd: 0.2, makesVideo: true });
    const id = await series({ cadence: "daily" });
    await worker();
    await until(async () => (await row(id)).status === "paused", 30_000);
    expect(await row(id)).toMatchObject({ status: "paused", paused_reason: "credit", current_run: null });
    expect(await runsOf(id)).toEqual([]);
    expect(await calls()).toEqual([]);
    expect(await balance()).toBe(0);
  });

  it("does not begin a 60 fps video while smooth motion is not offered: it stops, and buys nothing", async () => {
    await grant(5);
    await stage(0.31, { spendUsd: 0.2, makesVideo: true });
    const id = await series({ cadence: "daily" }, { fps: 60 });
    await worker();
    await until(async () => (await row(id)).status === "paused", 30_000);
    expect(await row(id)).toMatchObject({ status: "paused", paused_reason: "failed", current_run: null });
    expect(await runsOf(id)).toEqual([]);
    expect(await calls()).toEqual([]);
    expect(await balance()).toBe(5);
    expect(await open()).toBe(0);
  });

  it("begins a 60 fps video while smooth motion is offered", async () => {
    await grant(5);
    await stage(0.31, { spendUsd: 0.2, makesVideo: true });
    const id = await series({ cadence: "daily" }, { fps: 60 });
    await worker({ RUNPOD_UPSCALE_ENDPOINT: "ep-u", FLOWCHAIN_SMOOTH_MOTION: "on" });
    await until(async () => (await runsOf(id)).length === 1 && (await row(id)).current_run === null && (await open()) === 0, 30_000);
    const draft = (await calls()).find((c) => c[0] === "run")!;
    expect(draft).toEqual(expect.arrayContaining(["--fps", "60"]));
  });

  // (phase 14: the worker is the studio here, so its own switch decides; one worker per test, so no other picks it up)
  const soundDraft = async (env?: Record<string, string>) => {
    await grant(5);
    await stage(0.31, { spendUsd: 0.2, makesVideo: true });
    const id = await series({ cadence: "daily" }, { sfx: true });
    await worker(env);
    await until(async () => (await runsOf(id)).length === 1 && (await row(id)).current_run === null && (await open()) === 0, 30_000);
    return (await calls()).find((c) => c[0] === "run")!;
  };

  it("asks for no scene sound while the worker does not offer it, though the recipe has it on", async () => {
    expect(await soundDraft()).toContain("--no-sfx");
  });

  it("asks for scene sound while the worker offers it", async () => {
    expect(await soundDraft({ RUNPOD_FOLEY_ENDPOINT: "ep-f", FLOWCHAIN_SCENE_SOUND: "on" })).not.toContain("--no-sfx");
  });

  it("stops, and retries nothing, when a video is not finished", async () => {
    await grant(5);
    await stage(0.31, { spendUsd: 0.1, exitCode: 1 });
    const id = await series({ cadence: "daily2" });
    await worker();
    await until(async () => (await row(id)).status === "paused", 30_000);
    expect(await row(id)).toMatchObject({ status: "paused", paused_reason: "failed", current_run: null });
    await until(async () => (await open()) === 0);
    await new Promise((r) => setTimeout(r, 1200));
    // one script and one attempt at the rest, never a second
    expect((await calls()).filter((c) => c[0] !== "plan").map((c) => c[0])).toEqual(["run", "resume"]);
    // what the failed attempt bought is paid for, as for any run
    expect(await balance()).toBeLessThan(5);
    expect(await balance()).toBeGreaterThan(5 - 0.33);
  });

  it("leaves a series alone whose owner's files are on another studio's disk", async () => {
    await grant(5);
    await stage(0.31, { spendUsd: 0.2, makesVideo: true });
    const id = await series({ cadence: "daily" });
    // this worker's disk is another studio's: the same database, none of this user's files
    const elsewhere = join(studio.root, "another-studio-runs");
    await mkdir(elsewhere, { recursive: true });
    const w = startWorkerProcess({
      REDIS_URL: redis.url, FLOWCHAIN_ROOT: studio.root, RUNS_DIR: elsewhere, FLOWCHAIN_CLI: process.env.FLOWCHAIN_CLI!,
      DATABASE_URL: s.worker, WORKER_SERIES_MS: "300", WORKER_RECONCILE_KNOWN_USERS_ONLY: "1",
      GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c", RUNPOD_VOICE_ENDPOINT: "ep-v", R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s",
    });
    workers.push(w);
    await until(() => w.output().includes("ready") || w.child.exitCode !== null);
    await new Promise((r) => setTimeout(r, 2000));
    expect(await runsOf(id)).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "active", current_run: null });
    expect(await balance()).toBe(5);
    expect(await calls()).toEqual([]);
  });
});
