import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type Job as QueueJob, Queue, QueueEvents } from "bullmq";
import type { Redis } from "ioredis";
import type { Health } from "../config";
import { ApiError } from "../http";
import { currentUser } from "../tenant";
import {
  clientConnection, consumerConnection, JOB_OPTIONS, KEYS, type QuickJobData, type QuickJobResult, QUEUES, QUICK_WAIT_MS, type RunJobData,
} from "./redis";
import { exitCodeOf, readJobRecord, runFolder } from "./run-cli";
import type { Job, JobRunner, JobView, StudioHealth } from "./types";

/** What a studio that cannot reach its worker says about keys: nothing is known, so nothing is called missing. */
const UNKNOWN: Health = { missing: [], defaults: { budgetUsd: 3 } };
const HEALTH_TTL_MS = 5000;
/** Shorter than the container health check's own limit (5 s): an unanswered question must not fail that check. */
const HEALTH_WAIT_MS = 3000;

type Ends = { redis: Redis; runs: Queue<RunJobData>; quick: Queue<QuickJobData, QuickJobResult>; quickEvents: QueueEvents; health?: { at: number; value?: Health; failed?: boolean } };

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
  // the answers to quick jobs arrive on their own connection: an answer given before it listens would be missed
  const listening = Promise.race([made.quickEvents.waitUntilReady().then(() => {}, () => {}), new Promise<void>((done) => setTimeout(done, 3000))]);
  const both = Promise.all([connected, listening]).then(() => {});
  shared[ENDS] = { url, ends: made, connected: both };
  await both;
  return made;
}

/**
 * Asks the worker a quick question and waits for its answer. A finished quick job is removed at once, so an
 * answer that slipped past the listener (it was still connecting) leaves nothing to look up: these questions
 * are free and change nothing, so that one is simply asked again.
 */
async function ask(e: Ends, name: string, data: QuickJobData, waitMs: number): Promise<QuickJobResult> {
  for (let attempt = 0; ; attempt++) {
    const job = await e.quick.add(name, data, JOB_OPTIONS);
    try {
      return await job.waitUntilFinished(e.quickEvents, waitMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && /Missing key for job/.test(message)) continue;
      await job.remove().catch(() => {}); // an unanswered question is not left in line
      throw err;
    }
  }
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

/** Whether the worker says it has this run's CLI running. It knows even when the queue has lost track of the job. */
async function heldByWorker(redis: Redis, runId: string): Promise<boolean> {
  // only a living worker's word counts: a killed one leaves its list behind for a moment
  const [alive, raw] = await redis.mget(KEYS.worker, KEYS.held);
  if (!alive || !raw) return false;
  try {
    return (JSON.parse(raw) as string[]).includes(runId);
  } catch {
    return false;
  }
}

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

/** How many long jobs one account may have waiting or working (`STUDIO_USER_JOBS`, default 2). */
function userJobLimit(): number {
  const raw = process.env.STUDIO_USER_JOBS?.trim() ?? "";
  return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : 2;
}

/**
 * Whether the run is the caller's to ask about, in a studio with accounts. Run ids are unique across all users
 * and every user's runs live in a folder of their own, so a run is the caller's exactly when its folder is in
 * theirs (or, for a draft whose folder the worker has yet to make, when the waiting job is theirs). Without
 * this, the worker's word "that run is being worked on" would answer for anybody's run id.
 */
function mine(dir: string, q: { data: { userId?: string } } | undefined): boolean {
  const me = currentUser()?.id;
  return me === undefined || existsSync(dir) || q?.data.userId === me;
}

/** A queue record as far as the caller may know of it: another user's job is no job at all. */
function own<T extends { data: { userId?: string } }>(q: T | undefined): T | undefined {
  const me = currentUser()?.id;
  return q && me !== undefined && q.data.userId !== me ? undefined : q;
}

const taken = (runId: string) => new ApiError("job_active", `run ${runId} is already queued or working`, "wait for it to finish, or stop it first");

/** What must hold before a job for `runId` goes in line: a worker, no job of the run, room for the user. */
async function admit(e: Ends, runId: string): Promise<void> {
  await requireWorker(e.redis);
  if ((await heldByWorker(e.redis, runId)) || (await e.runs.getJob(runId))) throw taken(runId);
  const userId = currentUser()?.id;
  if (!userId) return;
  // one account cannot fill the line: free jobs count here, paid ones are also limited where credit is held
  const inLine = [...(await e.runs.getWaiting()), ...(await e.runs.getActive())].filter((j) => j.data.userId === userId).length;
  if (inLine >= userJobLimit()) {
    throw new ApiError("too_many_jobs", "you already have as many jobs waiting or working as one account may have", "wait for one to finish");
  }
}

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
  // The worker's own word comes first: a CLI it has running is running, also when a long Redis outage made the
  // queue put the job back in line or forget it. Its exit code on disk is the one thing that is newer still.
  if (existsSync(dir) && (await heldByWorker(e.redis, runId))) {
    const record = readJobRecord(dir);
    if (record && exitCodeOf(dir) === undefined) return { ...record, state: "running" };
  }
  const q = own(await e.runs.getJob(runId));
  if (q) {
    const state = await q.getState();
    // "active" is only what the worker last told Redis. With no worker alive nothing is being worked on: the
    // run folder says how far the job got, and the next worker removes this record before it takes a job.
    if (state === "active" && (await workerAlive(e.redis))) {
      // the worker writes job.json when it starts the CLI; until then the queue's own record stands in
      const record = readJobRecord(dir);
      if (!record || record.startedAt < q.data.enqueuedAt) return { ...fromQueue(q), state: "running" };
      // it ended and the queue has not been told yet (Redis was away at that moment)
      const code = exitCodeOf(dir);
      return code === undefined ? { ...record, state: "running" } : { ...record, state: "ended", exitCode: code };
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

    start: (runId, kind, args, approvedUsd, opts) =>
      reach(async () => {
        runFolder(runId);
        const e = await ends(url);
        await admit(e, runId);
        const userId = currentUser()?.id;
        const token = randomUUID();
        const data: RunJobData = { runId, kind, args, approvedUsd, enqueuedAt: new Date().toISOString(), token, ...(userId ? { userId } : {}), ...(opts?.reservationId ? { reservationId: opts.reservationId } : {}) };
        const added = await e.runs.add(kind, data, { ...JOB_OPTIONS, jobId: runId });
        // Two requests at once: the queue keeps the first job for an id and quietly ignores the second `add`, so
        // only the stored job says whose it is. (Already gone means it ran to its end in the meantime.)
        const stored = await e.runs.getJob(runId);
        if (stored && stored.data.token !== token) throw taken(runId);
        return (await view(e, runId)) ?? { ...fromQueue(added), state: "queued", position: 1 };
      }),

    stop: (runId) =>
      reach(async () => {
        runFolder(runId);
        const e = await ends(url);
        const gone = () => new ApiError("not_found", `run ${runId} has no running job`);
        const finished = (s: string | undefined) => s === "completed" || s === "failed" || s === "unknown";
        const q = own(await e.runs.getJob(runId));
        // somebody else's run does not exist, whether its job is waiting or being worked on
        if (!mine(runFolder(runId), q)) throw gone();
        // a CLI the worker has running is stopped through the worker, whatever the queue says of its job
        const held = await heldByWorker(e.redis, runId);
        if (!held) {
          const state = q ? await q.getState() : undefined;
          if (!q || finished(state)) throw gone();
          if (state !== "active") {
            try {
              await q.remove();
              // the credit that was held for it comes back now, not at the worker's next pass
              if (q.data.reservationId && q.data.userId) void ask(e, "release", { args: [], userId: q.data.userId, runId, reservationId: q.data.reservationId }, 3000).catch(() => {});
              return { ...fromQueue(q), stoppedAt: new Date().toISOString(), state: "stopped" };
            } catch (err) {
              // the worker took the job between the two calls: it is working now, and is stopped as such
              const now = await q.getState();
              if (finished(now)) throw gone();
              if (now !== "active") throw err;
            }
          }
        }
        // the worker ends the job's process group and records that it was stopped
        const listeners = await e.redis.publish(KEYS.cancel, runId);
        if (listeners === 0) throw new ApiError("worker_offline", "the worker is offline", "the job could not be told to stop; it is not running if the worker is down");
        // a record the queue put back in line while the CLI worked would only be handed out again
        if (held && q) await q.remove().catch(() => {});
        const seen = await view(e, runId);
        if (seen) return seen;
        if (q) return { ...fromQueue(q), state: "running" };
        throw gone();
      }),

    view: (runId) => reach(async () => view(await ends(url), runId)),

    cliText: (args) =>
      reach(async () => {
        const e = await ends(url);
        await requireWorker(e.redis);
        try {
          const userId = currentUser()?.id;
          return (await ask(e, "cli", { args, ...(userId ? { userId } : {}) }, QUICK_WAIT_MS)).stdout;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/timed out before finishing/.test(message)) {
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
          e.health = { at: Date.now(), value: JSON.parse((await ask(e, "health", { args: [] }, HEALTH_WAIT_MS)).stdout) as Health };
        } catch {
          // remembered like an answer, so a worker that does not answer is not asked again by every request;
          // what it said last still holds while it lives (its keys do not change without a restart)
          e.health = { at: Date.now(), value: e.health?.value, failed: true };
        }
      }
      if (!e.health.value) return { ...UNKNOWN, queue: { mode: "queue", redis: true, worker: false } };
      return { ...e.health.value, queue: { mode: "queue", redis: true, worker: true } };
    },

    ready: (runId) =>
      reach(async () => {
        runFolder(runId);
        await admit(await ends(url), runId);
      }),

    async release(runId, reservationId) {
      try {
        const userId = currentUser()?.id;
        if (!userId) return;
        const e = await ends(url);
        await ask(e, "release", { args: [], userId, runId, reservationId }, 3000);
      } catch {
        // the worker's regular pass gives the credit back within a minute or two
      }
    },

    // Not through reach(): what went wrong matters here (Stripe retries a webhook that was not fulfilled).
    async stripeEvent(eventId) {
      const e = await ends(url);
      if (!(await workerAlive(e.redis))) throw new ApiError("worker_offline", "the worker is offline");
      try {
        return (await ask(e, "stripe-event", { args: [], eventId }, 25_000)).stdout;
      } catch (err) {
        // why is the worker's to log (it does); the caller is told only that it is not done, so that it tries again
        console.error("billing:", err instanceof Error ? err.message : String(err));
        throw new ApiError("billing_unavailable", "the payment could not be fulfilled yet");
      }
    },

    async stripeCustomer() {
      const userId = currentUser()?.id;
      if (!userId) throw new ApiError("unauthenticated", "sign in first");
      const e = await ends(url);
      if (!(await workerAlive(e.redis))) throw new ApiError("worker_offline", "the worker is offline", "nothing was started; try again in a moment");
      try {
        return (await ask(e, "stripe-customer", { args: [], userId }, 25_000)).stdout;
      } catch (err) {
        console.error("billing:", err instanceof Error ? err.message : String(err));
        throw new ApiError("billing_unavailable", "payments are not available right now", "try again in a moment");
      }
    },

    restore: (runId) =>
      reach(async () => {
        runFolder(runId);
        const e = await ends(url);
        await requireWorker(e.redis);
        const userId = currentUser()?.id;
        if (!userId) return;
        try {
          await ask(e, "restore", { args: [], userId, runId }, QUICK_WAIT_MS);
        } catch (err) {
          console.error("restore:", err instanceof Error ? err.message : String(err));
          throw new ApiError("storage_unavailable", "the run could not be brought back from storage", "try again in a moment");
        }
      }),

    // the worker clears every lock when it starts: with one worker, a lock it did not just take is stale
    staleLock: async () => false,
    clearStaleLock: async (runId) => {
      runFolder(runId);
    },
  };
}
