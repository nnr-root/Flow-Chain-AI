import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as createDraft } from "@/app/api/drafts/route";
import { POST as generate } from "@/app/api/runs/[id]/generate/route";
import { DELETE as stop } from "@/app/api/runs/[id]/job/route";
import { POST as rerender } from "@/app/api/runs/[id]/rerender/route";
import { JOB_FILE } from "@/server/jobs";
import { closeQueue } from "@/server/jobs/queue";
import { JOB_OPTIONS, QUEUES } from "@/server/jobs/redis";
import { freshRunId, localSupabase, newUser, serviceClient, type TestUser } from "../../test/helpers/supabase";
import { draftManifest, finishedManifest, params, until, useStudio } from "./helpers";
import { hasRedisServer, startRedis, startWorkerProcess, type TestRedis, type TestWorker } from "./redis";
import { as, cookiesOf, saveRunFor, withAccounts } from "./tenant";

/*
 * Credit, end to end: the web holds a user's credit, the real worker (its own process, the stub CLI) checks it,
 * runs the job in the owner's folder and settles what it cost. Needs the local Supabase stack and
 * `redis-server`; skipped without either. Nothing here can reach a provider.
 */
const supa = localSupabase();
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

describe.skipIf(!supa || !hasRedisServer())("credit through the queue", () => {
  const s = supa!;
  const db = () => serviceClient(s);
  let a: TestUser;
  let b: TestUser;
  let aCookie: string;
  let bCookie: string;

  const folder = (u: TestUser) => join(studio.runs, u.id);
  const behave = async (u: TestUser, value: unknown) => {
    await mkdir(folder(u), { recursive: true });
    await writeFile(join(folder(u), "_behave.json"), JSON.stringify(value));
  };
  const priced = (u: TestUser, totalUsd: number) => writeFile(join(folder(u), "_plan.json"), JSON.stringify({ items: [], totalUsd }));
  const calls = async (u: TestUser): Promise<string[][]> => {
    const file = join(folder(u), "_calls.jsonl");
    if (!existsSync(file)) return [];
    return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  };
  const jobCalls = async (u: TestUser) => (await calls(u)).filter((c) => c[0] !== "plan");
  const balance = async (u: TestUser) => Number((await db().from("users").select("balance_usd").eq("id", u.id).single()).data!.balance_usd);
  const grant = async (u: TestUser, usd: number) => {
    const { error } = await db().rpc("grant_credit", { p_email: u.email, p_amount_usd: usd });
    if (error) throw new Error(error.message);
  };
  // of these two users only: other test files use the same database at the same time
  const openReservations = async () => (await db().from("reservations").select("id").eq("status", "open").in("user_id", [a.id, b.id])).data!.length;
  /** A run the user owns, in the database and on disk. */
  const ownRun = async (u: TestUser, manifest = draftManifest) => {
    const id = freshRunId();
    const { error } = await u.client.rpc("create_run", { p_id: id, p_topic: "foxes at night" });
    if (error) throw new Error(error.message);
    await saveRunFor(studio, u, manifest(id));
    return id;
  };
  const worker = async (env: Record<string, string> = {}): Promise<TestWorker> => {
    const w = startWorkerProcess({
      REDIS_URL: redis.url, FLOWCHAIN_ROOT: studio.root, RUNS_DIR: studio.runs, FLOWCHAIN_CLI: process.env.FLOWCHAIN_CLI!,
      SUPABASE_URL: s.url, SUPABASE_ANON_KEY: s.anonKey, SUPABASE_SERVICE_ROLE_KEY: s.serviceKey, WORKER_RECONCILE_MS: "1000",
      GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e", ELEVENLABS_VOICE_ID: "v", FAL_KEY: "f", ...env,
    });
    workers.push(w);
    await until(() => w.output().includes("ready") || w.child.exitCode !== null);
    return w;
  };
  const error = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

  beforeEach(async () => {
    await admin.flushall();
    process.env.REDIS_URL = redis.url;
    withAccounts(s);
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
    [aCookie, bCookie] = await Promise.all([cookiesOf(a), cookiesOf(b)]);
    await Promise.all([mkdir(folder(a), { recursive: true }), mkdir(folder(b), { recursive: true })]);
  });

  it("holds the approved amount, runs the CLI in the owner's folder without the server's keys, and settles the real cost", async () => {
    await worker();
    await grant(a, 2);
    const id = await ownRun(a);
    await priced(a, 0.31);
    await behave(a, { spendUsd: 0.27, envNames: true });

    const res = await generate(as(aCookie, `/api/runs/${id}/generate`, { json: { approvedUsd: 0.31 } }), params({ id }));
    expect(res.status).toBe(202);
    await until(async () => (await openReservations()) === 0);

    // the draft's manifest already had the script ($0.0055) in its ledger: the run's total is charged, once
    expect(await balance(a)).toBe(1.7245);
    expect(await balance(b)).toBe(0);
    expect(await jobCalls(a)).toEqual([["resume", id, "--budget", "0.31", "--cap", "0.31"]]);
    expect(await calls(b)).toEqual([]);
    expect(JSON.parse(await readFile(join(folder(a), "_env.json"), "utf8"))).toEqual([]);
    expect(existsSync(join(folder(a), id, JOB_FILE))).toBe(true);
    const { data: ledger } = await a.client.from("ledger").select("kind,amount_usd,balance_after_usd").order("id");
    expect(ledger).toEqual([
      { kind: "grant", amount_usd: 2, balance_after_usd: 2 },
      { kind: "reserve", amount_usd: -0.31, balance_after_usd: 1.69 },
      { kind: "settle", amount_usd: 0.0345, balance_after_usd: 1.7245 },
    ]);
    await until(async () => (await db().from("runs").select("charged_usd,state").eq("id", id).single()).data?.state !== "creating");
    expect((await db().from("runs").select("charged_usd").eq("id", id).single()).data).toEqual({ charged_usd: 0.2755 });
  });

  it("starts nothing when the credit does not cover the approved amount", async () => {
    await worker();
    await grant(a, 0.3);
    const id = await ownRun(a);
    await priced(a, 0.31);
    const res = await generate(as(aCookie, `/api/runs/${id}/generate`, { json: { approvedUsd: 0.31 } }), params({ id }));
    expect([res.status, await error(res)]).toEqual([402, "insufficient_credit"]);
    expect(await balance(a)).toBe(0.3);
    expect(await openReservations()).toBe(0);
    expect(await jobCalls(a)).toEqual([]);
    expect(await admin.keys(`bull:${QUEUES.runs}:[0-9]*`)).toEqual([]);
  });

  it("creates a draft as the user's own run and charges the script from their credit", async () => {
    await worker();
    await grant(a, 1);
    await writeFile(join(folder(a), "_draft-manifest.json"), JSON.stringify(draftManifest("20261006-120000-000000")));
    const input = { topic: "foxes at night", aspect: "9:16", scenes: 3, style: "auto", motion: "auto", provider: "fal", budgetUsd: 3, captionStyle: "preset", transition: "auto", musicGain: 0.35, sfxGain: 0.6, sfx: true, hook: { mode: "gemini" } };
    const res = await createDraft(as(aCookie, "/api/drafts", { json: input }), undefined);
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await until(async () => (await openReservations()) === 0);
    expect(await balance(a)).toBe(0.9945);
    expect(existsSync(join(folder(a), runId, "manifest.json"))).toBe(true);
    expect((await db().from("runs").select("user_id,topic,charged_usd").eq("id", runId).single()).data).toEqual({ user_id: a.id, topic: "foxes at night", charged_usd: 0.0055 });
    await until(async () => (await db().from("runs").select("state").eq("id", runId).single()).data?.state === "draft");

    // with nothing to spend, not even the script is bought
    const broke = await createDraft(as(bCookie, "/api/drafts", { json: input }), undefined);
    expect([broke.status, await error(broke)]).toEqual([402, "insufficient_credit"]);
    expect(await calls(b)).toEqual([]);
  });

  it("refuses a paid job that has no credit held for exactly it, whoever put it in the queue", async () => {
    await worker();
    await grant(a, 5);
    await grant(b, 5);
    const id = await ownRun(a);
    const other = await ownRun(b);
    const { data: bReservation } = await b.client.rpc("reserve_credit", { p_run_id: other, p_kind: "generate", p_cap_usd: 1 });
    const { data: aReservation } = await a.client.rpc("reserve_credit", { p_run_id: id, p_kind: "generate", p_cap_usd: 0.5 });
    const queue = new Queue(QUEUES.runs, { connection: admin });
    const job = (extra: Record<string, unknown>, cap = "4") =>
      ({ runId: id, kind: "generate", args: ["resume", id, "--budget", cap, "--cap", cap], enqueuedAt: new Date().toISOString(), token: "t", userId: a.id, ...extra });
    try {
      for (const data of [
        job({}), // no reservation at all
        job({ reservationId: bReservation }), // someone else's
        job({ reservationId: aReservation }), // its own, but for $0.50, not the $4 the command would spend up to
        job({ reservationId: aReservation, userId: undefined }, "0.5"), // nobody's job
      ]) {
        await queue.add("generate", data, { ...JOB_OPTIONS, jobId: id });
        await until(async () => (await queue.getJob(id)) === undefined);
      }
    } finally {
      await queue.close();
    }
    expect(await jobCalls(a)).toEqual([]);
    expect(await jobCalls(b)).toEqual([]);
  });

  it("gives the credit back when its job never ran: never queued, or its worker died", async () => {
    await grant(a, 1);
    const never = await ownRun(a);
    const killed = await ownRun(a);
    // held straight through the database, with no job behind it (anyone can do this with their own token)
    expect((await a.client.rpc("reserve_credit", { p_run_id: never, p_kind: "generate", p_cap_usd: 0.4 })).error).toBeNull();
    const first = await worker();
    await until(async () => (await balance(a)) === 0.9945 || (await openReservations()) === 0, 20_000);
    // only the script that run already had is charged
    expect(await balance(a)).toBe(0.9945);

    await priced(a, 0.2);
    await behave(a, { sleepMs: 30_000 });
    expect((await generate(as(aCookie, `/api/runs/${killed}/generate`, { json: { approvedUsd: 0.2 } }), params({ id: killed }))).status).toBe(202);
    await until(async () => (await jobCalls(a)).length === 1);
    expect(await balance(a)).toBe(0.7945);
    const { pid } = JSON.parse(await readFile(join(folder(a), killed, JOB_FILE), "utf8"));
    first.child.kill("SIGKILL");
    process.kill(-pid, "SIGKILL");
    await first.exited;
    workers = [];

    await behave(a, {});
    await worker();
    await until(async () => (await openReservations()) === 0, 20_000);
    expect(await balance(a)).toBe(0.989); // 1 − 0.0055 − 0.0055: each run's script, nothing else
    expect(await jobCalls(a)).toHaveLength(1); // not run again
  });

  it("limits how many long jobs one account has in line, and hides one user's job from another", async () => {
    await worker({ WORKER_CONCURRENCY: "1" });
    await behave(a, { sleepMs: 4000 });
    const ids = [await ownRun(a, finishedManifest), await ownRun(a, finishedManifest), await ownRun(a, finishedManifest)];
    const start = (id: string) => rerender(as(aCookie, `/api/runs/${id}/rerender`, { json: { look: {} } }), params({ id }));
    expect((await start(ids[0])).status).toBe(202);
    expect((await start(ids[1])).status).toBe(202);
    const third = await start(ids[2]);
    expect([third.status, await error(third)]).toEqual([429, "too_many_jobs"]);

    // b can neither see nor stop a's job, even knowing its id
    expect((await stop(as(bCookie, `/api/runs/${ids[1]}/job`, { method: "DELETE" }), params({ id: ids[1] }))).status).toBe(404);
    expect((await stop(as(aCookie, `/api/runs/${ids[1]}/job`, { method: "DELETE" }), params({ id: ids[1] }))).status).toBe(200);
    // and b's own line is not shortened by a's jobs
    await behave(b, {});
    const bRun = await ownRun(b, finishedManifest);
    expect((await rerender(as(bCookie, `/api/runs/${bRun}/rerender`, { json: { look: {} } }), params({ id: bRun }))).status).toBe(202);
  });
});
