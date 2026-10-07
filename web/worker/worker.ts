import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Job as QueueJob, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { RUN_ID } from "@src/studio/commands";
import { health, roots } from "../server/config";
import {
  consumerConnection, KEYS, type QuickJobData, type QuickJobResult, QUEUES, type RunJobData, type RunJobResult,
} from "../server/jobs/redis";
import { exitCodeOf, readJobRecord, runFolder, runShort, spawnCli, stopProcess } from "../server/jobs/run-cli";
import { type Job, LOCK_FILE } from "../server/jobs/types";

export type WorkerOptions = {
  redisUrl: string;
  /** Long jobs at once (default 2). */
  concurrency?: number;
  /** How long a shutdown waits for running jobs before ending them (default 30 min). */
  drainMs?: number;
  /** The guard's lifetime without renewal (default 15 s); renewed every third of it. */
  guardTtlMs?: number;
  /** BullMQ's lock on an active job and how often stalled jobs are looked for (defaults 30 s). */
  lockMs?: number;
  log?: (message: string) => void;
};

/** Thrown when another worker already holds the guard. */
export class SecondWorker extends Error {
  constructor(holder: string) {
    super(`another worker (${holder}) is already running; only one may run, because a starting worker clears every run lock`);
  }
}

// renew or release the guard only while it is still ours
const RENEW = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
const RELEASE = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/**
 * Removes every run's lock. Only the single worker may do this, and only before it takes a job: at that moment
 * no CLI can be running, so each lock is left over from a hard kill and would otherwise block Resume for ever.
 */
export async function sweepLocks(runsDir: string): Promise<string[]> {
  if (!existsSync(runsDir)) return [];
  const cleared: string[] = [];
  for (const id of await readdir(runsDir)) {
    const lock = join(runsDir, id, LOCK_FILE);
    if (!RUN_ID.test(id) || !existsSync(lock)) continue;
    await rm(lock, { force: true });
    cleared.push(id);
  }
  return cleared;
}

/**
 * Removes the jobs a dead worker left marked as "being worked on". Like the lock sweep, only the single worker
 * may do this and only before it takes a job: at that moment nothing is being worked on, whatever Redis says.
 * Without it such a run would read "working" and refuse Resume until the queue's own stall check came round.
 */
export async function clearOrphans(redis: Redis): Promise<string[]> {
  const cleared: string[] = [];
  for (const name of [QUEUES.runs, QUEUES.quick]) {
    const queue = new Queue(name, { connection: redis });
    queue.on("error", () => {});
    try {
      for (const job of await queue.getActive()) {
        if (!job.id) continue;
        // the dead worker's lock on the job would refuse the removal until it expires
        await redis.del(`${queue.toKey(job.id)}:lock`);
        await job.remove();
        if (name === QUEUES.runs) cleared.push(job.id);
      }
    } finally {
      await queue.close();
    }
  }
  return cleared;
}

/** How long a job that was told to end at shutdown gets before it is killed outright. */
const KILL_AFTER_MS = 10_000;

export type RunningWorker = { id: string; close: () => Promise<void> };

/**
 * The studio's one worker: takes the guard, clears stale locks, then runs queued jobs by starting the CLI for
 * each, exactly as the local runner does, and waiting for it. It never retries a job and never calls a provider itself.
 */
export async function startWorker(opts: WorkerOptions): Promise<RunningWorker> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const id = `${process.pid}-${Date.now().toString(36)}`;
  const guardTtl = opts.guardTtlMs ?? 15_000;
  const lockMs = opts.lockMs ?? 30_000;
  const redis = consumerConnection(opts.redisUrl);
  const subscriber = consumerConnection(opts.redisUrl);

  // A worker that was killed leaves its guard behind until it expires, so a restart right after a crash waits a
  // little longer than one lifetime for it. A worker that is really running keeps renewing, and this one gives up.
  const deadline = Date.now() + guardTtl + Math.max(500, Math.floor(guardTtl / 3));
  while ((await redis.set(KEYS.worker, id, "PX", guardTtl, "NX")) !== "OK") {
    if (Date.now() > deadline) {
      const holder = (await redis.get(KEYS.worker)) ?? "unknown";
      redis.disconnect();
      subscriber.disconnect();
      throw new SecondWorker(holder);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  /** Jobs this worker is running, by run id. */
  const active = new Map<string, { record: Job; child: ChildProcess; dir: string }>();
  /** Runs whose CLI is being started, and those among them that were told to stop meanwhile. */
  const starting = new Set<string>();
  const stopAfterStart = new Set<string>();
  const signalAll = (signal: NodeJS.Signals) => {
    for (const held of active.values()) {
      try {
        if (held.record.pid !== undefined) process.kill(-held.record.pid, signal);
      } catch {
        // already gone
      }
    }
  };

  const renew = async () => {
    if ((await redis.eval(RENEW, 1, KEYS.worker, id, String(guardTtl))) !== 0) return;
    // The guard ran out, which is what a Redis outage longer than its lifetime does. If nobody took it meanwhile
    // this is still the one worker: take it again and carry on, so the jobs that are running finish.
    if ((await redis.set(KEYS.worker, id, "PX", guardTtl, "NX")) === "OK") {
      log("worker: the single-worker guard had expired; took it again");
      return;
    }
    if ((await redis.get(KEYS.worker)) === id) return;
    // another worker holds it and has cleared the locks: nothing of this one's may go on beside it
    log("worker: lost the single-worker guard to another worker; ending running jobs and exiting");
    signalAll("SIGTERM");
    process.exit(1);
  };
  // one renewal at a time: while Redis is away they must not pile up and all answer at once when it is back
  let renewing = false;
  const renewal = setInterval(() => {
    if (renewing) return;
    renewing = true;
    renew()
      .catch(() => {}) // Redis is away: running jobs carry on and record their result on disk
      .finally(() => (renewing = false));
  }, Math.max(100, Math.floor(guardTtl / 3)));

  const orphans = await clearOrphans(redis);
  if (orphans.length > 0) log(`worker: removed the jobs a dead worker left of ${orphans.join(", ")}`);
  const cleared = await sweepLocks(roots().runs);
  if (cleared.length > 0) log(`worker: cleared stale locks of ${cleared.join(", ")}`);

  const runJob = async (job: QueueJob<RunJobData>): Promise<RunJobResult> => {
    const { runId, kind, args, approvedUsd } = job.data;
    const dir = runFolder(runId);
    // After a long Redis outage the queue can lose track of a job whose CLI is still working and hand the run
    // out again. One CLI per run, whatever the queue believes.
    if (active.has(runId) || starting.has(runId)) throw new Error(`run ${runId} is still being worked on by this worker`);
    starting.add(runId);
    let started: { job: Job; child: ChildProcess };
    try {
      started = await spawnCli(runId, kind, args, approvedUsd);
    } finally {
      starting.delete(runId);
    }
    const { job: record, child } = started;
    active.set(runId, { record, child, dir });
    log(`worker: ${kind} ${runId} started (pid ${record.pid})`);
    try {
      if (stopAfterStart.delete(runId)) await stopProcess(dir, record).catch(() => {});
      // the CLI may have ended while its record was being written: then there is no exit event left to wait for
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((done) => child.once("exit", () => done()));
    } finally {
      active.delete(runId);
    }
    const exitCode = exitCodeOf(dir) ?? null;
    const stopped = readJobRecord(dir)?.stoppedAt !== undefined;
    log(`worker: ${kind} ${runId} ${stopped ? "stopped" : exitCode === null ? "ended without an exit code" : `exit ${exitCode}`}`);
    // exit 1 (failed) and 2 (not confirmed) are results, not queue failures: nothing here is ever retried
    return { exitCode, ...(stopped ? { stopped } : {}) };
  };

  const runQuick = async (job: QueueJob<QuickJobData>): Promise<QuickJobResult> =>
    job.name === "health" ? { stdout: JSON.stringify(health()) } : { stdout: await runShort(job.data.args) };

  const common = { maxStalledCount: 0, stalledInterval: lockMs, lockDuration: lockMs };
  const runs = new Worker<RunJobData, RunJobResult>(QUEUES.runs, runJob, { ...common, connection: consumerConnection(opts.redisUrl), concurrency: opts.concurrency ?? 2 });
  const quick = new Worker<QuickJobData, QuickJobResult>(QUEUES.quick, runQuick, { ...common, connection: consumerConnection(opts.redisUrl), concurrency: 4 });
  for (const w of [runs, quick]) w.on("error", (err) => log(`worker: ${err.message}`));

  await subscriber.subscribe(KEYS.cancel);
  subscriber.on("message", (_channel, runId) => {
    const held = active.get(runId);
    if (!held) {
      // asked to stop while its CLI is being started: stop it as soon as it is
      if (starting.has(runId)) stopAfterStart.add(runId);
      return;
    }
    log(`worker: stopping ${runId}`);
    stopProcess(held.dir, held.record).catch((err: Error) => log(`worker: could not stop ${runId}: ${err.message}`));
  });
  await Promise.all([runs.waitUntilReady(), quick.waitUntilReady()]);
  log(`worker ${id}: ready (runs ×${opts.concurrency ?? 2}, quick ×4)`);

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const drainMs = opts.drainMs ?? 30 * 60_000;
      log(`worker: shutting down; waiting up to ${Math.round(drainMs / 1000)} s for ${active.size} running job(s)`);
      // stop taking jobs, let the running ones finish
      const drained = Promise.all([runs.close(), quick.close()]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([drained.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), drainMs)))]);
      clearTimeout(timer);
      if (!finished) {
        // out of time: end what is left. No stoppedAt is recorded, so these runs read "interrupted" and can be resumed.
        for (const runId of active.keys()) log(`worker: ending ${runId} (not finished in time)`);
        signalAll("SIGTERM");
        // a CLI that ignores the request is killed, so the shutdown always ends
        const kill = setTimeout(() => signalAll("SIGKILL"), KILL_AFTER_MS);
        await drained.catch(() => {});
        clearTimeout(kill);
      }
      clearInterval(renewal);
      await redis.eval(RELEASE, 1, KEYS.worker, id).catch(() => {});
      subscriber.disconnect();
      redis.disconnect();
      log("worker: stopped");
    })());

  return { id, close };
}

/** The guard's holder, for a health check ("is the worker this process?"). */
export const guardHolder = (redis: Redis): Promise<string | null> => redis.get(KEYS.worker);
