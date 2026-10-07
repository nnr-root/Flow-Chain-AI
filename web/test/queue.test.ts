import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cliJson, cliText, JOB_FILE, runner, startJob, stopJob, studioHealth, viewJob } from "@/server/jobs";
import { closeQueue } from "@/server/jobs/queue";
import { KEYS, QUEUES } from "@/server/jobs/redis";
import { runEvents } from "@/server/events";
import { readRun } from "@/server/runs";
import { calls, draftManifest, nextRunId, saveRun, stub, until, useStudio } from "./helpers";
import { hasRedisServer, startRedis, startWorkerProcess, type TestRedis, type TestWorker } from "./redis";

/*
 * The queue path against a real Redis and the real worker in its own process, with the stub CLI: nothing here
 * can reach a provider. Skipped on a machine without `redis-server`.
 */
const studio = useStudio();
let redis: TestRedis;
let admin: Redis;
let workers: TestWorker[] = [];

beforeAll(async () => {
  if (!hasRedisServer()) return;
  redis = await startRedis();
  admin = new Redis(redis.url, { maxRetriesPerRequest: null });
  admin.on("error", () => {});
});
afterAll(async () => {
  admin?.disconnect();
  await redis?.stop();
});
beforeEach(async () => {
  if (!redis) return;
  await admin.flushall();
  process.env.REDIS_URL = redis.url;
});
afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  workers = [];
  await closeQueue();
});

/** Starts the worker for this test's studio and waits until it takes jobs. */
async function worker(env: Record<string, string> = {}): Promise<TestWorker> {
  const w = startWorkerProcess({ REDIS_URL: redis.url, FLOWCHAIN_ROOT: studio.root, RUNS_DIR: studio.runs, FLOWCHAIN_CLI: process.env.FLOWCHAIN_CLI!, ...env });
  workers.push(w);
  await until(() => w.output().includes("ready") || w.child.exitCode !== null);
  return w;
}
const state = async (id: string) => (await viewJob(id))?.state;
const ended = (id: string) => until(async () => ((await state(id)) === "ended" ? viewJob(id) : null));
const inRedis = async (id: string) => (await admin.exists(`bull:${QUEUES.runs}:${id}`)) === 1;

describe.skipIf(!hasRedisServer())("the queue runner and the worker", () => {
  it("with a Redis address the studio queues its work, and the worker reports which keys it has (names only)", async () => {
    await worker({ GEMINI_API_KEY: "secret-g" });
    expect(runner().mode).toBe("queue");
    const health = await studioHealth();
    expect(health.queue).toEqual({ mode: "queue", redis: true, worker: true });
    expect(health.missing.always).toEqual(["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"]);
    expect(JSON.stringify(health)).not.toContain("secret-g");
  });

  it("runs a job through the worker: the CLI gets its arguments, the run folder gets the job files, Redis keeps nothing", async () => {
    await worker();
    const id = nextRunId();
    const started = await startJob(id, "generate", ["resume", id, "--budget", "0.3", "--cap", "0.3"], 0.3);
    expect(["queued", "running"]).toContain(started.state);
    expect(await ended(id)).toMatchObject({ kind: "generate", approvedUsd: 0.3, exitCode: 0, args: ["resume", id, "--budget", "0.3", "--cap", "0.3"] });
    expect(await calls(studio)).toEqual([["resume", id, "--budget", "0.3", "--cap", "0.3"]]);
    expect(JSON.parse(await readFile(join(studio.runs, id, JOB_FILE), "utf8")).pid).toBeGreaterThan(0);
    expect(await readFile(join(studio.runs, id, "job.log"), "utf8")).toContain("▶ resume");
    await until(async () => !(await inRedis(id)));
    // the id is free again: the same run can be queued for its next action
    await startJob(id, "rerender", ["rerender", id]);
    await until(async () => (await calls(studio)).length === 2);
  });

  it("hands the CLI's exit code back as the result and never runs a failed job again", async () => {
    await worker();
    for (const exitCode of [1, 2]) {
      await stub(studio, "_behave.json", { exitCode });
      const id = nextRunId();
      await startJob(id, "generate", ["resume", id]);
      expect(await ended(id)).toMatchObject({ exitCode });
    }
    await new Promise((r) => setTimeout(r, 1500)); // longer than the worker's stalled-job check in these tests
    expect(await calls(studio)).toHaveLength(2);
    expect(await admin.keys(`bull:${QUEUES.runs}:2026*`)).toEqual([]);
  });

  it("keeps one job per run: a second start is refused while the first waits or works, also when two arrive together", async () => {
    await stub(studio, "_behave.json", { sleepMs: 1500 });
    await worker();
    const id = nextRunId();
    const both = await Promise.allSettled([startJob(id, "generate", ["resume", id]), startJob(id, "generate", ["resume", id])]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "job_active" });
    await until(async () => (await state(id)) === "running");
    await expect(startJob(id, "rerender", ["rerender", id])).rejects.toMatchObject({ code: "job_active" });
    await ended(id);
    expect(await calls(studio)).toHaveLength(1);
  });

  it("makes further jobs wait their turn, in order, and tells each its place in line", async () => {
    await stub(studio, "_behave.json", { sleepMs: 1200 });
    await worker({ WORKER_CONCURRENCY: "1" });
    const [a, b, c] = [nextRunId(), nextRunId(), nextRunId()];
    await saveRun(studio, draftManifest(b));
    await startJob(a, "generate", ["resume", a]);
    await until(async () => (await state(a)) === "running");
    await startJob(b, "generate", ["resume", b]);
    await startJob(c, "generate", ["resume", c]);
    expect(await viewJob(b)).toMatchObject({ state: "queued", position: 1, kind: "generate" });
    expect(await viewJob(c)).toMatchObject({ state: "queued", position: 2 });
    expect((await readRun(b)).state).toBe("queued");
    await ended(c);
    expect((await calls(studio)).map((call) => call[1])).toEqual([a, b, c]);
  });

  it("the live feed follows a run through the line: queued, working, ended, though no file changes while it waits", async () => {
    await stub(studio, "_behave.json", { sleepMs: 1000 });
    await worker({ WORKER_CONCURRENCY: "1" });
    const [a, b] = [nextRunId(), nextRunId()];
    await saveRun(studio, draftManifest(b));
    await startJob(a, "generate", ["resume", a]);
    await until(async () => (await state(a)) === "running");
    await startJob(b, "generate", ["resume", b]);

    const abort = new AbortController();
    const reader = runEvents(b, abort.signal, { heartbeatMs: 60_000 }).getReader();
    const seen: string[] = [];
    const decoder = new TextDecoder();
    const deadline = Date.now() + 20_000;
    while (!seen.includes("ended") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const m of decoder.decode(value).matchAll(/^event: run\ndata: (.*)$/gm)) {
        const job = (JSON.parse(m[1]) as { job: { state: string } | null }).job;
        if (job && seen.at(-1) !== job.state) seen.push(job.state);
      }
    }
    abort.abort();
    expect(seen).toEqual(["queued", "running", "ended"]);
  });

  it("stop takes a waiting job out of the line, and ends a running one through the worker", async () => {
    await stub(studio, "_behave.json", { sleepMs: 30_000 });
    await worker({ WORKER_CONCURRENCY: "1" });
    const [a, b] = [nextRunId(), nextRunId()];
    await startJob(a, "generate", ["resume", a]);
    await until(async () => (await calls(studio)).length === 1);
    await startJob(b, "generate", ["resume", b]);

    expect((await stopJob(b)).state).toBe("stopped");
    expect(await inRedis(b)).toBe(false);
    expect(await viewJob(b)).toBeNull(); // it never ran: the run folder has no job of it

    await stopJob(a);
    await until(async () => (await state(a)) === "stopped");
    const { pid } = JSON.parse(await readFile(join(studio.runs, a, JOB_FILE), "utf8"));
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect((await calls(studio)).map((call) => call[1])).toEqual([a]);
    await expect(stopJob(b)).rejects.toMatchObject({ code: "not_found" });
  });

  it("a job whose worker dies is interrupted, not run again; the next worker clears the lock it left", async () => {
    await stub(studio, "_behave.json", { sleepMs: 30_000 });
    const first = await worker();
    const id = nextRunId();
    await startJob(id, "generate", ["resume", id]);
    await until(async () => (await calls(studio)).length === 1);
    const { pid } = JSON.parse(await readFile(join(studio.runs, id, JOB_FILE), "utf8"));
    // the container dies: the worker and, with it, the CLI it started; the CLI's lock stays behind
    await writeFile(join(studio.runs, id, ".lock"), `${pid}\n`);
    first.child.kill("SIGKILL");
    process.kill(-pid, "SIGKILL");
    await first.exited;

    // with no worker alive the run does not go on reading "working", whatever Redis still has on record,
    // and a stop has nobody to tell
    await until(async () => (await admin.exists(KEYS.worker)) === 0);
    expect(await inRedis(id)).toBe(true);
    expect(await state(id)).toBe("interrupted");
    await expect(stopJob(id)).rejects.toMatchObject({ code: "worker_offline" });

    await stub(studio, "_behave.json", {});
    const second = await worker();
    // the next worker removes what the dead one left before it takes a job: the run is free at once
    expect(second.output()).toContain(`removed the jobs a dead worker left of ${id}`);
    expect(second.output()).toContain(`cleared stale locks of ${id}`);
    expect(existsSync(join(studio.runs, id, ".lock"))).toBe(false);
    expect(await inRedis(id)).toBe(false);
    expect(await state(id)).toBe("interrupted");
    await new Promise((r) => setTimeout(r, 1500));
    expect(await calls(studio)).toHaveLength(1); // not re-run
    // resumable: the user's next action is a new job
    await startJob(id, "generate", ["resume", id]);
    expect(await ended(id)).toMatchObject({ exitCode: 0 });
  });

  it("free, short commands go through the quick queue and come back with the CLI's output or its error", async () => {
    await worker();
    await stub(studio, "_plan.json", { items: [{ stage: "tts", scene: 1, costUsd: 0.02 }], totalUsd: 0.02 });
    expect(await cliJson(["plan", "x", "--json"])).toEqual({ items: [{ stage: "tts", scene: 1, costUsd: 0.02 }], totalUsd: 0.02 });
    await stub(studio, "_behave.json", { exitCode: 1 });
    await expect(cliText(["look", "x"])).rejects.toMatchObject({ code: "validation" });
    expect(await calls(studio)).toEqual([["plan", "x", "--json"], ["look", "x"]]);
  });

  it("with the worker offline nothing is queued: actions are refused with that reason", async () => {
    const w = await worker();
    await w.stop();
    workers = [];
    await until(async () => (await admin.exists(KEYS.worker)) === 0);
    expect((await studioHealth()).queue).toEqual({ mode: "queue", redis: true, worker: false });
    const id = nextRunId();
    await expect(startJob(id, "generate", ["resume", id])).rejects.toMatchObject({ code: "worker_offline" });
    await expect(cliText(["plan", id, "--json"])).rejects.toMatchObject({ code: "worker_offline" });
    expect(await inRedis(id)).toBe(false);
    expect(await admin.keys("bull:*:[0-9]*")).toEqual([]);
  });

  it("a second worker refuses to start", async () => {
    await worker();
    const second = startWorkerProcess({ REDIS_URL: redis.url, FLOWCHAIN_ROOT: studio.root, RUNS_DIR: studio.runs, FLOWCHAIN_CLI: process.env.FLOWCHAIN_CLI! });
    expect(await second.exited).toBe(3);
    expect(second.output()).toContain("only one may run");
  });

  it("a shutdown lets a running job finish; past its time limit it ends the job, which then reads interrupted", async () => {
    await stub(studio, "_behave.json", { sleepMs: 1200 });
    const patient = await worker();
    const a = nextRunId();
    await startJob(a, "generate", ["resume", a]);
    await until(async () => (await calls(studio)).length === 1);
    expect(await patient.stop()).toBe(0);
    workers = [];
    expect(await viewJob(a)).toMatchObject({ state: "ended", exitCode: 0 });

    await stub(studio, "_behave.json", { sleepMs: 30_000 });
    const hurried = await worker({ WORKER_DRAIN_MS: "300" });
    const b = nextRunId();
    await startJob(b, "generate", ["resume", b]);
    await until(async () => (await calls(studio)).length === 2);
    expect(await hurried.stop()).toBe(0);
    workers = [];
    expect(hurried.output()).toContain(`ending ${b}`);
    await until(async () => (await state(b)) === "interrupted");
  });

  it("with Redis away actions answer 'unavailable' at once; jobs already in line are still there when it is back", async () => {
    await stub(studio, "_behave.json", { sleepMs: 1500 });
    await worker({ WORKER_CONCURRENCY: "1" });
    const [a, b] = [nextRunId(), nextRunId()];
    await mkdir(join(studio.runs, a), { recursive: true });
    await startJob(a, "generate", ["resume", a]);
    await until(async () => (await calls(studio)).length === 1);
    await startJob(b, "generate", ["resume", b]);

    await redis.stop();
    const c = nextRunId();
    const t0 = Date.now();
    await expect(startJob(c, "generate", ["resume", c])).rejects.toMatchObject({ code: "queue_unavailable" });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await studioHealth()).queue).toEqual({ mode: "queue", redis: false, worker: false });

    // away for longer than the worker's guard lives (1.5 s here): the worker takes the guard again and carries on
    await new Promise((r) => setTimeout(r, 2500));
    await redis.start();
    // the running job recorded its result on disk whatever Redis did; the waiting one is taken once Redis is back
    await until(async () => (await calls(studio)).length === 2, 30_000);
    await until(async () => {
      try {
        return (await state(b)) === "ended" && (await state(a)) === "ended";
      } catch {
        return false; // still reconnecting
      }
    }, 30_000);
    expect((await calls(studio)).map((call) => call[1])).toEqual([a, b]);
    expect(workers[0].child.exitCode).toBeNull(); // the same worker, still running
    expect(workers[0].output()).toContain("took it again");
  });
});
