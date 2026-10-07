import { randomUUID } from "node:crypto";
import { type Job as QueueJob, Queue, QueueEvents } from "bullmq";
import type { Redis } from "ioredis";
import type { Health } from "../config";
import { ApiError } from "../http";
import {
  clientConnection, consumerConnection, JOB_OPTIONS, KEYS, type QuickJobData, type QuickJobResult, QUEUES, QUICK_WAIT_MS, type RunJobData,
} from "./redis";
import { exitCodeOf, readJobRecord, runFolder } from "./run-cli";
import type { Job, JobRunner, JobView, StudioHealth } from "./types";

/** What a studio that cannot reach its worker says about keys: nothing is known, so nothing is called missing. */
const UNKNOWN: Health = { missing: { always: [], fal: [], runpod: [] }, defaults: { provider: "fal", budgetUsd: 3 } };
const HEALTH_TTL_MS = 5000;

type Ends = { redis: Redis; runs: Queue<RunJobData>; quick: Queue<QuickJobData, QuickJobResult>; quickEvents: QueueEvents; health?: { at: number; value: Health } };

/** One set of connections per process, also across a dev-server recompile. */
const ENDS = Symbol.for("flowchain.studio.queue");
const shared = globalThis as { [ENDS]?: { url: string; ends: Ends; connected: Promise<void> } };

async function ends(url: string): Promise<Ends> {
  const current = shared[ENDS];
  if (current?.url === url) {
    await current.connected;
    return current.ends;
  }
  const redis = clientConnection(url);
  // connection errors surface on the command that needed the connection; without a listener they would be thrown
  redis.on("error", () => {});
  const made: Ends = {
    redis,
    runs: new Queue(QUEUES.runs, { connection: redis }),
    quick: new Queue(QUEUES.quick, { connection: redis }),
    quickEvents: new QueueEvents(QUEUES.quick, { connection: consumerConnection(url) }),
  };
  made.runs.on("error", () => {});
  made.quick.on("error", () => {});
  made.quickEvents.on("error", () => {});
  // commands fail at once while there is no connection, so the first callers wait a moment for it to be made
  const connected = new Promise<void>((done) => {
    const timer = setTimeout(done, 3000);
    redis.once("ready", () => {
      clearTimeout(timer);
      done();
    });
  });
  shared[ENDS] = { url, ends: made, connected };
  await connected;
  return made;
}

/** Closes the process's queue connections (tests; a clean shutdown). */
export async function closeQueue(): Promise<void> {
  const current = shared[ENDS];
  if (!current) return;
  delete shared[ENDS];
  const { runs, quick, quickEvents, redis } = current.ends;
  await Promise.allSettled([runs.close(), quick.close(), quickEvents.close()]);
  redis.disconnect();
}

/** Any failure to talk to Redis is the same thing to the user: nothing was queued, try again when it is back. */
async function reach<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("queue_unavailable", "the job queue is unavailable", "nothing was started; try again in a moment");
  }
}

const workerAlive = async (redis: Redis): Promise<boolean> => (await redis.exists(KEYS.worker)) === 1;

async function requireWorker(redis: Redis): Promise<void> {
  if (!(await workerAlive(redis))) {
    throw new ApiError("worker_offline", "the worker is offline", "nothing was started; it picks up again when the worker is back");
  }
}

const fromQueue = (q: QueueJob<RunJobData>): Job => ({
  id: `q-${q.id}-${q.timestamp}`,
  kind: q.data.kind,
  args: q.data.args,
  startedAt: q.data.enqueuedAt,
  approvedUsd: q.data.approvedUsd,
});

/** Where a waiting job stands: 1 is next. */
async function position(runs: Queue<RunJobData>, runId: string): Promise<number> {
  // the waiting list is in the order the worker will take the jobs
  const index = (await runs.getWaiting()).findIndex((j) => j.id === runId);
  return index < 0 ? 1 : index + 1;
}

/**
 * The run's job as the server sees it. Redis knows who is waiting and who is working; the run folder knows how
 * the last job ended. A pid in job.json belongs to the worker's container and means nothing here.
 */
async function view(e: Ends, runId: string): Promise<JobView | null> {
  const dir = runFolder(runId);
  const q = await e.runs.getJob(runId);
  if (q) {
    const state = await q.getState();
    if (state === "active") {
      // the worker writes job.json when it starts the CLI; until then the queue's own record stands in
      const record = readJobRecord(dir);
      const mine = record && record.startedAt >= q.data.enqueuedAt ? record : fromQueue(q);
      return { ...mine, state: "running" };
    }
    if (state === "waiting" || state === "prioritized" || state === "delayed" || state === "waiting-children") {
      return { ...fromQueue(q), state: "queued", position: await position(e.runs, runId) };
    }
  }
  const record = readJobRecord(dir);
  if (!record) return null;
  const code = exitCodeOf(dir);
  if (code !== undefined) return { ...record, state: "ended", exitCode: code };
  return { ...record, state: record.stoppedAt ? "stopped" : "interrupted" };
}

/**
 * The server's runner: work goes to the worker through Redis. A run's job id is its run id, so the queue itself
 * holds at most one job per run; a job that cannot start because the worker is away is refused, not left to
 * run unattended later.
 */
export function queueRunner(url: string): JobRunner {
  return {
    mode: "queue",

    start: (runId, kind, args, approvedUsd) =>
      reach(async () => {
        runFolder(runId);
        const e = await ends(url);
        await requireWorker(e.redis);
        const taken = () => new ApiError("job_active", `run ${runId} is already queued or working`, "wait for it to finish, or stop it first");
        if (await e.runs.getJob(runId)) throw taken();
        const token = randomUUID();
        const added = await e.runs.add(kind, { runId, kind, args, approvedUsd, enqueuedAt: new Date().toISOString(), token }, { ...JOB_OPTIONS, jobId: runId });
        // Two requests at once: the queue keeps the first job for an id and quietly ignores the second `add`, so
        // only the stored job says whose it is. (Already gone means it ran to its end in the meantime.)
        const stored = await e.runs.getJob(runId);
        if (stored && stored.data.token !== token) throw taken();
        return (await view(e, runId)) ?? { ...fromQueue(added), state: "queued", position: 1 };
      }),

    stop: (runId) =>
      reach(async () => {
        runFolder(runId);
        const e = await ends(url);
        const q = await e.runs.getJob(runId);
        const state = q ? await q.getState() : undefined;
        if (!q || state === "completed" || state === "failed" || state === "unknown") throw new ApiError("not_found", `run ${runId} has no running job`);
        if (state === "active") {
          // the worker that holds the job ends its process group and records that it was stopped
          await e.redis.publish(KEYS.cancel, runId);
          return (await view(e, runId)) ?? { ...fromQueue(q), state: "running" };
        }
        await q.remove();
        return { ...fromQueue(q), stoppedAt: new Date().toISOString(), state: "stopped" };
      }),

    view: (runId) => reach(async () => view(await ends(url), runId)),

    cliText: (args) =>
      reach(async () => {
        const e = await ends(url);
        await requireWorker(e.redis);
        const job = await e.quick.add("cli", { args }, JOB_OPTIONS);
        try {
          return (await job.waitUntilFinished(e.quickEvents, QUICK_WAIT_MS)).stdout;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/timed out before finishing/.test(message)) {
            await job.remove().catch(() => {});
            throw new ApiError("worker_offline", "the worker is busy or offline", "nothing was started; try again in a moment");
          }
          // the CLI's own last error line, as the local runner reports it
          throw new ApiError("validation", message);
        }
      }),

    async health(): Promise<StudioHealth> {
      const e = await ends(url);
      let worker: boolean;
      try {
        worker = await workerAlive(e.redis);
      } catch {
        return { ...UNKNOWN, queue: { mode: "queue", redis: false, worker: false } };
      }
      if (!worker) return { ...UNKNOWN, queue: { mode: "queue", redis: true, worker: false } };
      if (!e.health || Date.now() - e.health.at > HEALTH_TTL_MS) {
        try {
          const job = await e.quick.add("health", { args: [] }, JOB_OPTIONS);
          e.health = { at: Date.now(), value: JSON.parse((await job.waitUntilFinished(e.quickEvents, 10_000)).stdout) as Health };
        } catch {
          return { ...UNKNOWN, queue: { mode: "queue", redis: true, worker: false } };
        }
      }
      return { ...e.health.value, queue: { mode: "queue", redis: true, worker: true } };
    },

    // the worker clears every lock when it starts: with one worker, a lock it did not just take is stale
    staleLock: async () => false,
    clearStaleLock: async (runId) => {
      runFolder(runId);
    },
  };
}
