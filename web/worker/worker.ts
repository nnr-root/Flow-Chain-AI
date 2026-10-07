import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Job as QueueJob, Worker } from "bullmq";
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
  const renewal = setInterval(() => {
    redis.eval(RENEW, 1, KEYS.worker, id, String(guardTtl)).then(
      (kept) => {
        if (kept === 0) {
          // the guard expired and someone else may hold it: this worker must not go on as if it were alone
          log("worker: lost the single-worker guard; exiting");
          process.exit(1);
        }
      },
      () => {}, // Redis is away: running jobs carry on and record their result on disk
    );
  }, Math.max(100, Math.floor(guardTtl / 3)));

  const cleared = await sweepLocks(roots().runs);
  if (cleared.length > 0) log(`worker: cleared stale locks of ${cleared.join(", ")}`);

  /** Jobs this worker is running, by run id. */
  const active = new Map<string, { record: Job; child: ChildProcess; dir: string }>();

  const runJob = async (job: QueueJob<RunJobData>): Promise<RunJobResult> => {
    const { runId, kind, args, approvedUsd } = job.data;
    const dir = runFolder(runId);
    const { job: record, child } = await spawnCli(runId, kind, args, approvedUsd);
    active.set(runId, { record, child, dir });
    log(`worker: ${kind} ${runId} started (pid ${record.pid})`);
    try {
      await new Promise<void>((done) => child.once("exit", () => done()));
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
    if (!held) return;
    log(`worker: stopping ${runId}`);
    void stopProcess(held.dir, held.record);
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
        for (const [runId, held] of active) {
          log(`worker: ending ${runId} (not finished in time)`);
          try {
            if (held.record.pid !== undefined) process.kill(-held.record.pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
        await Promise.allSettled([runs.close(true), quick.close(true)]);
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
