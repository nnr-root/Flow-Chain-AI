import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as kits, POST as createKit } from "@/app/api/brand-kits/route";
import { POST as createDraft } from "@/app/api/drafts/route";
import { GET as runs } from "@/app/api/runs/route";
import { GET as file } from "@/app/api/runs/[id]/files/[...path]/route";
import { GET as run } from "@/app/api/runs/[id]/route";
import { POST as generate } from "@/app/api/runs/[id]/generate/route";
import { DELETE as stop } from "@/app/api/runs/[id]/job/route";
import { GET as viewRun } from "@/app/api/runs/[id]/route";
import { POST as rerender } from "@/app/api/runs/[id]/rerender/route";
import { JOB_FILE } from "@/server/jobs";
import { closeQueue } from "@/server/jobs/queue";
import { JOB_OPTIONS, QUEUES } from "@/server/jobs/redis";
import { ObjectStore } from "@/server/store/s3";
import { keys } from "@/server/store/sync";
import { freshRunId, localDb, newUser, serviceClient, type TestUser } from "../../test/helpers/db";
import { draftManifest, finishedManifest, params, until, useStudio } from "./helpers";
import { hasDocker, startStore, type TestStore } from "./minio";
import { hasRedisServer, startRedis, startWorkerProcess, type TestRedis, type TestWorker } from "./redis";
import { as, cookiesOf, saveRunFor, withAccounts } from "./tenant";

/*
 * Credit, end to end: the web holds a user's credit, the real worker (its own process, the stub CLI) checks it,
 * runs the job in the owner's folder and settles what it cost. Needs the local database and
 * `redis-server`; skipped without either. Nothing here can reach a provider.
 */
const supa = localDb();
const studio = useStudio();
let redis: TestRedis;
let admin: Redis;
let workers: TestWorker[] = [];
let bucket: TestStore | undefined;

beforeAll(async () => {
  if (!supa || !hasRedisServer()) return;
  if (hasDocker()) bucket = await startStore();
  redis = await startRedis();
  admin = new Redis(redis.url, { maxRetriesPerRequest: null });
  admin.on("error", () => {});
});
afterAll(async () => {
  admin?.disconnect();
  await redis?.stop();
  bucket?.stop();
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
  /** a's run as its manifest reads now; nothing of it while the stand-in CLI is in the middle of writing the file. */
  const manifestNow = async (id: string): Promise<{ scenes: Array<{ jobs?: { clips?: { expectedUsd?: number; submittedAt: string } } }> }> => {
    try {
      return JSON.parse(await readFile(join(folder(a), id, "manifest.json"), "utf8"));
    } catch {
      return { scenes: [{}] };
    }
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
      DATABASE_URL: s.worker, WORKER_RECONCILE_MS: "1000",
      // other test files use the same database at the same time: this worker leaves their users' credit alone
      WORKER_RECONCILE_KNOWN_USERS_ONLY: "1",
      GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c", RUNPOD_VOICE_ENDPOINT: "ep-v", R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s", ...bucket?.env, ...env,
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
    if (bucket) Object.assign(process.env, bucket.env);
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
    [aCookie, bCookie] = await Promise.all([cookiesOf(s, a), cookiesOf(s, b)]);
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
    const input = { topic: "foxes at night", aspect: "9:16", scenes: 3, style: "auto", motion: "auto", clips: "480p", budgetUsd: 3, captionStyle: "preset", transition: "auto", musicGain: 0.35, sfxGain: 0.6, sfx: true, hook: { mode: "auto" } };
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
        // "free" by its kind, spending by its command: the kind is not taken on trust
        job({ kind: "rerender" }, "100"),
        // no kind at all
        job({ kind: undefined }, "100"),
        // the cap the credit was held for, and after it the one a command line would really use
        { ...job({ reservationId: aReservation }, "0.5"), args: ["resume", id, "--budget", "0.5", "--cap", "0.5", "--cap", "500"] },
      ]) {
        await queue.add(String(data.kind), data, { ...JOB_OPTIONS, jobId: id });
        await until(async () => (await queue.getJob(id)) === undefined);
      }
      expect(await jobCalls(a)).toEqual([]);
      expect(await jobCalls(b)).toEqual([]);
      // and the one job that credit IS held for, exactly, runs (so the refusals above were not a worker refusing everything)
      await queue.add("generate", job({ reservationId: aReservation }, "0.5"), { ...JOB_OPTIONS, jobId: id });
      await until(async () => (await jobCalls(a)).length === 1);
    } finally {
      await queue.close();
    }
    expect(await jobCalls(a)).toEqual([["resume", id, "--budget", "0.5", "--cap", "0.5"]]);
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

  it("charges for a provider job that was submitted and never collected: stopping after the submit is not free", async () => {
    await worker();
    await grant(a, 1);
    const id = await ownRun(a);
    await priced(a, 0.5);
    // the stand-in CLI "submits" a $0.20 clip and then waits for it
    await behave(a, { pendingUsd: 0.2, sleepMs: 30_000 });
    expect((await generate(as(aCookie, `/api/runs/${id}/generate`, { json: { approvedUsd: 0.5 } }), params({ id }))).status).toBe(202);
    await until(async () => (await manifestNow(id)).scenes[0].jobs?.clips?.expectedUsd === 0.2);
    expect((await stop(as(aCookie, `/api/runs/${id}/job`, { method: "DELETE" }), params({ id }))).status).toBe(200);
    await until(async () => (await openReservations()) === 0);
    // the script the run already had, and the clip the provider will bill for: 1 − 0.0055 − 0.2
    expect(await balance(a)).toBe(0.7945);
  });

  it("keeps charging for jobs that were submitted and then given up: a second stopped reroll is not free", async () => {
    await worker();
    await grant(a, 2);
    const id = await ownRun(a);
    await priced(a, 0.5);
    const stopAfterSubmit = async (pendingUsd: number, abandonedUsd?: number) => {
      // the stand-in CLI does what the pipeline does when a new job replaces one in flight: the old one's cost is kept
      await behave(a, { pendingUsd, abandonedUsd, sleepMs: 30_000 });
      const before = (await jobCalls(a)).length;
      const since = Date.now();
      expect((await generate(as(aCookie, `/api/runs/${id}/generate`, { json: { approvedUsd: 0.5 } }), params({ id }))).status).toBe(202);
      await until(async () => (await jobCalls(a)).length === before + 1);
      // (this command's own submit: the one before left the same expected cost in the manifest)
      await until(async () => {
        const clips = (await manifestNow(id)).scenes[0].jobs?.clips;
        return clips?.expectedUsd === pendingUsd && new Date(clips.submittedAt).getTime() >= since;
      });
      expect((await stop(as(aCookie, `/api/runs/${id}/job`, { method: "DELETE" }), params({ id }))).status).toBe(200);
      await until(async () => (await openReservations()) === 0);
    };
    await stopAfterSubmit(0.2);
    expect(await balance(a)).toBe(1.7945); // 2 − script 0.0055 − the first clip 0.20
    await stopAfterSubmit(0.2, 0.2);
    expect(await balance(a)).toBe(1.5945); // and the second one too
  });

  it("gives credit back at once when the job it was held for could not be queued, and only to its owner", async () => {
    // a reconcile pass so rare that it cannot be what settles here
    await worker({ WORKER_RECONCILE_MS: "600000" });
    await grant(a, 1);
    const id = await ownRun(a);
    const { data: reservationId, error: held } = await a.client.rpc("reserve_credit", { p_run_id: id, p_kind: "generate", p_cap_usd: 0.4 });
    expect(held).toBeNull();
    expect(await balance(a)).toBe(0.6);
    const quick = new Queue(QUEUES.quick, { connection: admin });
    try {
      // somebody else asking changes nothing
      await quick.add("release", { args: [], userId: b.id, runId: id, reservationId }, JOB_OPTIONS);
      // nor does asking about the run without naming the reservation: a later one would belong to another job
      await quick.add("release", { args: [], userId: a.id, runId: id }, JOB_OPTIONS);
      await quick.add("release", { args: [], userId: a.id, runId: id, reservationId: "00000000-0000-4000-8000-000000000000" }, JOB_OPTIONS);
      await new Promise((r) => setTimeout(r, 1000));
      expect(await openReservations()).toBe(1);
      await quick.add("release", { args: [], userId: a.id, runId: id, reservationId }, JOB_OPTIONS);
      await until(async () => (await openReservations()) === 0, 10_000);
    } finally {
      await quick.close();
    }
    expect(await balance(a)).toBe(0.9945);
  });

  it("does not return the credit of a run that was charged before and has no manifest on this disk", async () => {
    const w = await worker();
    await grant(a, 1);
    const id = await ownRun(a);
    await priced(a, 0.2);
    await behave(a, { spendUsd: 0.1 });
    expect((await generate(as(aCookie, `/api/runs/${id}/generate`, { json: { approvedUsd: 0.2 } }), params({ id }))).status).toBe(202);
    await until(async () => (await openReservations()) === 0);
    expect(await balance(a)).toBe(0.8945);

    // the wrong disk: the run's folder is not here, and credit is held for the run again
    await rm(join(folder(a), id), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect((await a.client.rpc("reserve_credit", { p_run_id: id, p_kind: "generate", p_cap_usd: 0.3 })).error).toBeNull();
    await until(() => w.output().includes("its credit stays held"), 20_000);
    expect(await openReservations()).toBe(1);
    expect(await balance(a)).toBe(0.5945);
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

    // b can neither see nor stop a's job, even knowing its id: not the one waiting, and not the one being worked on
    expect((await stop(as(bCookie, `/api/runs/${ids[1]}/job`, { method: "DELETE" }), params({ id: ids[1] }))).status).toBe(404);
    await until(async () => (await jobCalls(a)).length === 1);
    expect((await stop(as(bCookie, `/api/runs/${ids[0]}/job`, { method: "DELETE" }), params({ id: ids[0] }))).status).toBe(404);
    expect((await viewRun(as(bCookie, `/api/runs/${ids[0]}`), params({ id: ids[0] }))).status).toBe(404);
    await new Promise((r) => setTimeout(r, 500));
    expect(JSON.parse(await readFile(join(folder(a), ids[0], JOB_FILE), "utf8")).stoppedAt).toBeUndefined();
    expect((await stop(as(aCookie, `/api/runs/${ids[1]}/job`, { method: "DELETE" }), params({ id: ids[1] }))).status).toBe(200);
    // and b's own line is not shortened by a's jobs
    await behave(b, {});
    const bRun = await ownRun(b, finishedManifest);
    expect((await rerender(as(bCookie, `/api/runs/${bRun}/rerender`, { json: { look: {} } }), params({ id: bRun }))).status).toBe(202);
  });

  describe.skipIf(!hasDocker())("with the bucket", () => {
    const stored = async (prefix: string) => (await new ObjectStore(bucket!.settings).list(prefix)).map((o) => o.key.slice(prefix.length)).sort();

    it("keeps a run in the bucket after its job, lists it when this disk has lost it, and brings it back to be opened and resumed", async () => {
      await worker();
      await grant(a, 2);
      const id = await ownRun(a, finishedManifest);
      await writeFile(join(folder(a), id, "final.mp4"), "the video");
      await priced(a, 0.2);
      await behave(a, { spendUsd: 0.1 });
      expect((await generate(as(aCookie, `/api/runs/${id}/generate`, { json: { approvedUsd: 0.2 } }), params({ id }))).status).toBe(202);
      await until(async () => !!(await db().from("runs").select("stored_at").eq("id", id).single()).data?.stored_at);
      expect(await stored(keys.run(a.id, id))).toEqual(["final.mp4", "job.exit", "job.json", "job.log", "manifest.json"]);
      expect(await stored(keys.run(b.id, id))).toEqual([]);

      // the disk loses the run (a new server, or the clean-up)
      await rm(join(folder(a), id), { recursive: true });
      const listed = async (cookie: string) => ((await (await runs(as(cookie, "/api/runs"), undefined)).json()) as { runs: Array<{ runId: string; state: string }> }).runs.filter((r) => r.runId === id);
      expect(await listed(aCookie)).toEqual([expect.objectContaining({ runId: id, state: "stored", topic: "foxes at night" })]);
      expect(await listed(bCookie)).toEqual([]);
      // nobody else can have it brought back
      expect((await run(as(bCookie, `/api/runs/${id}`), params({ id }))).status).toBe(404);
      expect(existsSync(join(folder(b), id))).toBe(false);

      const opened = await run(as(aCookie, `/api/runs/${id}`), params({ id }));
      expect(opened.status).toBe(200);
      expect(await readFile(join(folder(a), id, "final.mp4"), "utf8")).toBe("the video");
      const before = await balance(a);
      expect((await generate(as(aCookie, `/api/runs/${id}/generate`, { json: { approvedUsd: 0.2 } }), params({ id }))).status).toBe(202);
      await until(async () => (await openReservations()) === 0);
      // only the new spend is charged: what the run had cost before is on record in the database, not on the lost disk
      expect(Math.round((before - (await balance(a))) * 10_000) / 10_000).toBe(0.1);
    });

    it("serves a file this disk lacks by a short-lived link to the owner's own copy", async () => {
      await worker();
      const id = await ownRun(a, finishedManifest);
      await writeFile(join(folder(a), id, "final.mp4"), "the video");
      await behave(a, {});
      expect((await rerender(as(aCookie, `/api/runs/${id}/rerender`, { json: { look: {} } }), params({ id }))).status).toBe(202);
      await until(async () => !!(await db().from("runs").select("stored_at").eq("id", id).single()).data?.stored_at);
      await rm(join(folder(a), id, "final.mp4"));

      const res = await file(as(aCookie, `/api/runs/${id}/files/final.mp4`), params({ id, path: ["final.mp4"] }));
      expect(res.status).toBe(302);
      const link = res.headers.get("location")!;
      expect(link).toContain(`/users/${a.id}/runs/${id}/final.mp4?`);
      expect(await (await fetch(link)).text()).toBe("the video");
      expect((await file(as(bCookie, `/api/runs/${id}/files/final.mp4`), params({ id, path: ["final.mp4"] }))).status).toBe(404);
    });

    it("keeps an uploaded brand kit in the owner's part of the bucket and brings it back to a disk that lost it", async () => {
      const form = new FormData();
      form.set("name", "Acme");
      form.set("logo", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "logo.png"));
      expect((await createKit(as(aCookie, "/api/brand-kits", { body: form }), undefined)).status).toBe(201);
      expect(await stored(keys.brandKits(a.id))).toEqual(["acme/brand.json", "acme/logo.png"]);
      expect((await a.client.from("brand_kits").select("slug,name")).data).toEqual([{ slug: "acme", name: "Acme" }]);

      const kitDir = join(studio.root, "brand-kits", a.id);
      await rm(kitDir, { recursive: true });
      const list = async (cookie: string) => ((await (await kits(as(cookie, "/api/brand-kits"), undefined)).json()) as { kits: Array<{ slug: string }> }).kits.map((k) => k.slug);
      expect(await list(aCookie)).toEqual(["acme"]);
      expect(existsSync(join(kitDir, "acme/logo.png"))).toBe(true);
      expect(await list(bCookie)).toEqual([]);
    });
  });
});
