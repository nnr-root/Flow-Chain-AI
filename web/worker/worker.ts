import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Job as QueueJob, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { RUN_ID } from "@src/studio/commands";
import { DRAFT_CAP_USD } from "../lib/credit";
import { multiTenant } from "../lib/supabase/settings";
import { baseRoots, health, roots } from "../server/config";
import {
  commandKind, consumerConnection, KEYS, type QuickJobData, type QuickJobResult, QUEUES, refusal, type RunJobData, type RunJobResult,
} from "../server/jobs/redis";
import { exitCodeOf, lockState, readJobRecord, runFolder, runShort, spawnCli, stopProcess } from "../server/jobs/run-cli";
import { type Job, type JobView, LOCK_FILE } from "../server/jobs/types";
import { readManifest, stateOf } from "../server/runs";
import { objectStore } from "../server/store/s3";
import { cleanCache, isStored, keys, restoreFolder, storeFolder } from "../server/store/sync";
import { inScope, UUID } from "../server/tenant";
import { billing } from "./billing";
import { type Reservation, spendOf, tenantDb } from "./tenant";

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
  /** With accounts: how often open reservations without a job are settled, and how old one must be (default 60 s both). */
  reconcileMs?: number;
  /** Tests only (see `settleIdle`). */
  reconcileKnownUsersOnly?: boolean;
  /** With billing: how often Stripe is asked for events no webhook brought (default hourly). */
  catchUpMs?: number;
  log?: (message: string) => void;
};

const PAID = new Set(["draft", "generate", "reroll"]);

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
  // with accounts every user has a folder of runs of their own
  const folders = multiTenant() ? (await readdir(runsDir)).filter((name) => UUID.test(name)).map((name) => join(runsDir, name)) : [runsDir];
  const cleared: string[] = [];
  for (const folder of folders) {
    for (const id of await readdir(folder)) {
      const lock = join(folder, id, LOCK_FILE);
      if (!RUN_ID.test(id) || !existsSync(lock)) continue;
      await rm(lock, { force: true });
      cleared.push(id);
    }
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

  /** Tells the web which runs are being worked on, whatever the queue's own records say. */
  const publishHeld = () => redis.set(KEYS.held, JSON.stringify([...new Set([...active.keys(), ...starting])]), "PX", guardTtl);
  const renew = async () => {
    await publishHeld().catch(() => {}); // the guard's renewal must not depend on this write
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

  // a killed worker's list would otherwise be read as this worker's until the first renewal
  await publishHeld();
  const orphans = await clearOrphans(redis);
  if (orphans.length > 0) log(`worker: removed the jobs a dead worker left of ${orphans.join(", ")}`);
  const cleared = await sweepLocks(baseRoots().runs);
  if (cleared.length > 0) log(`worker: cleared stale locks of ${cleared.join(", ")}`);

  /**
   * Removes a run's lock when the process that wrote it is gone: a CLI killed outright (out of memory, say)
   * cannot remove its own, and the lock would refuse this run's every later job. A lock whose process lives —
   * a quick command at work on the run, a CLI someone started by hand — is never touched.
   */
  const clearDeadLock = async (dir: string) => {
    if (lockState(dir) === "dead") await rm(join(dir, LOCK_FILE), { force: true });
  };

  // With accounts: the database as the service role sees it, for checking and settling the credit held for a job.
  const db = tenantDb();
  const asUser = <T>(userId: string | undefined, work: () => Promise<T>): Promise<T> => {
    // A job that names a user belongs to a studio with accounts. A worker without them (half a set-up) would run
    // it in the shared folder, hold nobody to their credit and settle nothing: it does not run it.
    if (!db && userId) throw new Error("the job is a user's, and this worker has no accounts configured");
    if (!db) return work();
    // every path below is the job's user's own; a job that names no user, or no real one, is nobody's
    if (!userId || !UUID.test(userId)) throw new Error("the job names no user");
    return inScope({ user: { id: userId, email: "" } }, work);
  };

  /**
   * A paid job runs only when credit is held for exactly it: an open reservation of this user, for this run and
   * kind, whose amount is the cap the command itself carries. Whatever put the job in Redis, it cannot spend
   * what nobody approved.
   */
  const checkReservation = async (data: RunJobData): Promise<void> => {
    if (!db || !PAID.has(data.kind)) return;
    const r = data.reservationId && UUID.test(data.reservationId) ? await db.reservation(data.reservationId) : null;
    const capArg = data.args.includes("--cap") ? Number(data.args[data.args.indexOf("--cap") + 1]) : Number.NaN;
    const cap = data.kind === "draft" ? DRAFT_CAP_USD : capArg;
    const matches = r && r.status === "open" && r.run_id === data.runId && r.user_id === data.userId && r.kind === data.kind && Math.abs(r.cap_usd - cap) < 0.00005;
    if (!matches) throw new Error(`no credit is held for this ${data.kind} of ${data.runId}`);
  };

  // With accounts and a bucket: runs are kept there, and this disk is a cache of them.
  const bucket = db ? objectStore() : null;
  /** Runs whose store failed (the bucket was away), as "userId/runId"; the reconcile tries them again. */
  const unstored = new Set<string>();
  const cacheDays = (() => {
    const raw = process.env.STUDIO_CACHE_DAYS?.trim() ?? "";
    return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : 14;
  })();

  /** Copies what changed in a run's folder to the bucket. Must run in the owner's scope. */
  const storeRun = async (userId: string, runId: string): Promise<void> => {
    if (!db || !bucket) return;
    try {
      const dir = runFolder(runId);
      // nothing to keep yet: a run without a manifest is not recorded as stored
      if (!existsSync(join(dir, "manifest.json"))) return;
      const sent = await storeFolder(bucket, dir, keys.run(userId, runId));
      await db.setRunState(runId, null, new Date().toISOString());
      unstored.delete(`${userId}/${runId}`);
      if (sent > 0) log(`worker: stored ${sent} file(s) of ${runId}`);
    } catch (err) {
      unstored.add(`${userId}/${runId}`);
      log(`worker: could not store ${runId} yet: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Before a job: what it needs and this disk lacks (the run itself, the user's kits and tracks) is fetched from the bucket. */
  const bringLocal = async (data: RunJobData): Promise<void> => {
    if (!bucket || !data.userId) return;
    const dir = runFolder(data.runId);
    // A run folder has its manifest only once it has everything else (a restore fetches it last), so a manifest
    // here means the run is whole. Without one the run must come from the bucket, and if it cannot, the job does
    // not start: the pipeline would take what is missing for work to be done, and paid for, again.
    if (data.kind !== "draft" && !existsSync(join(dir, "manifest.json"))) await restoreFolder(bucket, keys.run(data.userId, data.runId), dir);
    // kits and tracks are a convenience here: with the bucket away a job that needs none of them still runs
    for (const [prefix, to] of [[keys.brandKits(data.userId), roots().brandKits], [keys.music(data.userId), roots().uploads]] as const) {
      await restoreFolder(bucket, prefix, to).catch((err: Error) => log(`worker: could not fetch ${prefix} (${err.message}); carrying on with what is on disk`));
    }
  };

  /**
   * What to settle a reservation at, or undefined when that cannot be said yet (the reservation then stays open).
   * A run without a manifest has spent nothing only if nothing was ever charged for it; a run that was charged
   * before and has no manifest here is on the wrong disk, and returning its credit would be a gift.
   */
  const unsettleable = new Set<string>();
  const settleAt = async (runId: string, dir: string, userId?: string): Promise<number | undefined> => {
    let total = spendOf(dir);
    if (total !== null) return total;
    if (!db || (await db.chargedFor(runId)) > 0) {
      // the run is kept in the bucket: fetch it, and what it spent can be read after all
      if (db && bucket && userId) {
        await restoreFolder(bucket, keys.run(userId, runId), dir).catch(() => 0);
        total = spendOf(dir);
        if (total !== null) {
          unsettleable.delete(runId);
          return total;
        }
      }
      // said once per run, not at every pass
      if (!unsettleable.has(runId)) log(`worker: ${runId} was charged before but has no manifest on this disk; its credit stays held`);
      unsettleable.add(runId);
      return undefined;
    }
    return 0;
  };

  // With billing: the one place a Stripe payment becomes credit.
  const pay = db ? billing(log) : null;
  /** Webhooks can be missed (the web was down for longer than Stripe retries): ask Stripe what happened lately. */
  const catchUp = async (): Promise<void> => {
    if (!pay) return;
    try {
      const done = await pay.catchUp();
      if (done > 0) log(`worker: fulfilled ${done} Stripe event(s) no webhook had brought`);
    } catch (err) {
      log(`worker: could not ask Stripe for recent events: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** After a job, however it ended: charge what the run really spent and record how the run stands. */
  const account = async (data: Pick<RunJobData, "runId" | "reservationId" | "userId">, dir: string, job: JobView | null): Promise<void> => {
    if (!db) return;
    try {
      const total = data.reservationId ? await settleAt(data.runId, dir, data.userId) : undefined;
      if (data.reservationId && total !== undefined) {
        const charged = await db.settle(data.reservationId, total);
        log(`worker: ${data.runId} settled at $${charged.toFixed(4)}`);
      }
      await db.setRunState(data.runId, stateOf(await readManifest(data.runId).catch(() => null), job));
    } catch (err) {
      // the database is away: the reservation stays open and the next reconcile settles it
      log(`worker: could not settle ${data.runId} yet: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * Settles a reservation whose run has no job: neither waiting nor being worked on here. This worker runs every
   * job there is, so such a reservation belongs to nothing that could still spend.
   */
  const settleIdle = async (r: Reservation): Promise<boolean> => {
    if (!db || !UUID.test(r.user_id)) return false;
    // Tests only: several workers share one database there, each with a runs folder of its own. A worker then
    // leaves alone the credit of users it has never seen. (In production one database has one worker, and a
    // user's first draft, never queued, has no folder: this rule would strand its credit.)
    if (opts.reconcileKnownUsersOnly && !existsSync(join(baseRoots().runs, r.user_id))) return false;
    if (active.has(r.run_id) || starting.has(r.run_id) || (await line.getJob(r.run_id))) return false;
    return inScope({ user: { id: r.user_id, email: "" } }, async () => {
      const dir = runFolder(r.run_id);
      const total = await settleAt(r.run_id, dir, r.user_id);
      if (total === undefined) return false;
      const charged = await db.settle(r.id, total);
      log(`worker: settled the credit held for ${r.run_id}, which has no job: $${charged.toFixed(4)} of $${r.cap_usd.toFixed(4)}`);
      const record = readJobRecord(dir);
      const code = exitCodeOf(dir);
      const job: JobView | null = !record ? null : code !== undefined ? { ...record, state: "ended", exitCode: code } : { ...record, state: record.stoppedAt ? "stopped" : "interrupted" };
      await db.setRunState(r.run_id, stateOf(await readManifest(r.run_id).catch(() => null), job));
      return true;
    });
  };

  const runJob = (job: QueueJob<RunJobData>): Promise<RunJobResult> => asUser(job.data.userId, async () => {
    const { runId, args, approvedUsd } = job.data;
    const dir = runFolder(runId);
    // What a job is, is what its command is. The job's own word for it must agree, and is never what decides
    // whether credit has to be held: a job that calls itself free, or nothing at all, would otherwise spend unasked.
    const kind = commandKind(args);
    if (kind === undefined || job.data.kind !== kind) throw new Error(refusal("runs", args, runId) ?? `the job says it is "${String(job.data.kind)}" and its command is not`);
    const refused = refusal("runs", args, runId, kind);
    if (refused) throw new Error(refused);
    // After a long Redis outage the queue can lose track of a job whose CLI is still working and hand the run
    // out again. One CLI per run, whatever the queue believes.
    if (active.has(runId) || starting.has(runId)) throw new Error(`run ${runId} is still being worked on by this worker`);
    // from here the run counts as being worked on: nothing else may settle its credit or touch its folder
    starting.add(runId);
    let started: { job: Job; child: ChildProcess };
    try {
      await checkReservation({ ...job.data, kind });
      await bringLocal({ ...job.data, kind });
      await clearDeadLock(dir);
      started = await spawnCli(runId, kind, args, approvedUsd);
    } catch (err) {
      stopAfterStart.delete(runId);
      throw err;
    } finally {
      starting.delete(runId);
    }
    const { job: record, child } = started;
    active.set(runId, { record, child, dir });
    publishHeld().catch(() => {});
    log(`worker: ${kind} ${runId} started (pid ${record.pid})`);
    try {
      if (stopAfterStart.delete(runId)) await stopProcess(dir, record).catch(() => {});
      // the CLI may have ended while its record was being written: then there is no exit event left to wait for
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((done) => child.once("exit", () => done()));
    } finally {
      // the CLI is gone; if it could not remove its own lock, the run must not stay shut because of it
      await clearDeadLock(dir).catch(() => {});
      active.delete(runId);
      publishHeld().catch(() => {});
    }
    const exitCode = exitCodeOf(dir) ?? null;
    const stopped = readJobRecord(dir)?.stoppedAt !== undefined;
    log(`worker: ${kind} ${runId} ${stopped ? "stopped" : exitCode === null ? "ended without an exit code" : `exit ${exitCode}`}`);
    const ended: JobView = exitCode !== null ? { ...record, state: "ended", exitCode } : { ...record, state: stopped ? "stopped" : "interrupted" };
    await account(job.data, dir, ended);
    // after every job, also a failed or stopped one: what was bought so far must outlive this disk
    if (job.data.userId) await storeRun(job.data.userId, runId);
    // exit 1 (failed) and 2 (not confirmed) are results, not queue failures: nothing here is ever retried
    return { exitCode, ...(stopped ? { stopped } : {}) };
  });

  const runQuick = async (job: QueueJob<QuickJobData>): Promise<QuickJobResult> => {
    if (job.name === "health") return { stdout: JSON.stringify(health()) };
    if (job.name === "restore") {
      // a run its owner opened that this disk does not hold
      const { userId, runId } = job.data;
      if (!bucket || !userId || !runId) throw new Error("nothing to restore from");
      // a run that is being worked on is on this disk already, and newer than anything stored
      if (active.has(runId) || starting.has(runId)) return { stdout: "0" };
      return asUser(userId, async () => ({ stdout: String(await restoreFolder(bucket, keys.run(userId, runId), runFolder(runId))) }));
    }
    if (job.name === "release") {
      // the web held credit for a job it then could not queue: give it back now rather than at the next reconcile
      const { runId, reservationId } = job.data;
      if (!db || !runId || !reservationId || !UUID.test(reservationId)) return { stdout: "" };
      // Exactly the reservation that was asked about — a later one for the same run belongs to another job —
      // and only when it is its owner's, still open, and (in settleIdle) the run really has no job.
      const held = await db.reservation(reservationId);
      const done = held && held.status === "open" && held.run_id === runId && held.user_id === job.data.userId ? await settleIdle(held) : false;
      return { stdout: done ? "released" : "" };
    }
    if (job.name === "stripe-event" || job.name === "stripe-customer") {
      if (!pay) throw new Error("this worker takes no payments (STRIPE_SECRET_KEY is not set)");
      // The web passes on only an id. What the event says is asked of Stripe; whose customer it is, is asked of
      // Stripe too. Nothing that reaches this worker through Redis can make credit out of nothing.
      if (job.name === "stripe-event") return { stdout: await pay.fulfil(String(job.data.eventId ?? "")) };
      return { stdout: await pay.customer(String(job.data.userId ?? "")) };
    }
    const refused = refusal("quick", job.data.args);
    if (refused) throw new Error(refused);
    return asUser(job.data.userId, async () => ({ stdout: await runShort(job.data.args) }));
  };

  /**
   * Settles credit that is held for no job: one that was never queued after its reservation, one whose worker
   * died, one that could not be settled because the database was away. This worker runs every job there is,
   * so a reservation whose run is neither waiting nor being worked on here belongs to nothing that could
   * still spend; its run's manifest says what was spent.
   */
  const line = new Queue<RunJobData>(QUEUES.runs, { connection: redis });
  line.on("error", () => {});
  const reconcileMs = opts.reconcileMs ?? 60_000;
  let reconciling = false;
  const reconcile = async (): Promise<void> => {
    if (!db || reconciling) return;
    reconciling = true;
    try {
      for (const r of await db.openReservations(reconcileMs)) await settleIdle(r);
      // stores that failed while the bucket was away
      for (const entry of [...unstored]) {
        const [userId, runId] = entry.split("/");
        if (active.has(runId) || starting.has(runId)) continue;
        await inScope({ user: { id: userId, email: "" } }, () => storeRun(userId, runId));
      }
    } catch (err) {
      log(`worker: could not reconcile credit: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reconciling = false;
    }
  };

  /** At start: runs on this disk that changed since they were last stored (a worker that died before its store). */
  const noteUnstored = async (): Promise<void> => {
    if (!bucket) return;
    const base = baseRoots().runs;
    if (!existsSync(base)) return;
    for (const userId of (await readdir(base)).filter((name) => UUID.test(name))) {
      for (const runId of (await readdir(join(base, userId))).filter((name) => RUN_ID.test(name))) {
        if (!(await isStored(join(base, userId, runId)).catch(() => true))) unstored.add(`${userId}/${runId}`);
      }
    }
  };
  /** Daily: free this disk of runs that are wholly in the bucket and long untouched. */
  const clean = async (): Promise<void> => {
    if (!bucket) return;
    try {
      const removed = await cleanCache(baseRoots().runs, cacheDays, Date.now(), (runId) => active.has(runId) || starting.has(runId));
      if (removed.length > 0) log(`worker: freed the disk of ${removed.length} stored run(s) untouched for ${cacheDays} days`);
    } catch (err) {
      log(`worker: could not clean the disk: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

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
  // nothing is running yet, so every reservation old enough is one a dead worker or a lost job left behind
  await noteUnstored();
  await reconcile();
  const reconciler = db ? setInterval(() => void reconcile(), reconcileMs) : undefined;
  void clean();
  const cleaner = bucket ? setInterval(() => void clean(), 24 * 3600_000) : undefined;
  void catchUp();
  const catcher = pay ? setInterval(() => void catchUp(), opts.catchUpMs ?? 3600_000) : undefined;
  log(`worker ${id}: ready (runs ×${opts.concurrency ?? 2}, quick ×4${db ? ", with accounts" : ""})`);

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const drainMs = opts.drainMs ?? 30 * 60_000;
      log(`worker: shutting down; waiting up to ${Math.round(drainMs / 1000)} s for ${active.size} running job(s)`);
      // Stop taking jobs and let the running ones finish. Quick questions are answered until then: the studio
      // goes on showing prices and which keys are set, and its health check does not fail for the length of a drain.
      const drained = runs.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([drained.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), drainMs)))]);
      clearTimeout(timer);
      if (!finished) {
        // out of time: end what is left. No stoppedAt is recorded, so these runs read "interrupted" and can be resumed.
        for (const runId of active.keys()) log(`worker: ending ${runId} (not finished in time)`);
        signalAll("SIGTERM");
        // a CLI that ignores the request is killed, so the shutdown always ends
        const kill = setTimeout(() => signalAll("SIGKILL"), KILL_AFTER_MS);
        // bounded: with Redis away the queue cannot be told how the jobs ended, and would wait for ever
        let giveUp: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([drained.catch(() => {}), new Promise((r) => (giveUp = setTimeout(r, KILL_AFTER_MS + 5000)))]);
        clearTimeout(giveUp);
        clearTimeout(kill);
      }
      let slow: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([quick.close().catch(() => {}), new Promise((r) => (slow = setTimeout(r, 5000)))]);
      clearTimeout(slow);
      clearInterval(renewal);
      clearInterval(reconciler);
      clearInterval(cleaner);
      clearInterval(catcher);
      await line.close().catch(() => {});
      // with Redis away these would wait for it to come back; both keys expire by themselves
      const released = (async () => {
        await redis.del(KEYS.held);
        await redis.eval(RELEASE, 1, KEYS.worker, id);
      })().catch(() => {});
      let late: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([released, new Promise((r) => (late = setTimeout(r, 3000)))]);
      clearTimeout(late);
      subscriber.disconnect();
      redis.disconnect();
      log("worker: stopped");
    })());

  return { id, close };
}

/** The guard's holder, for a health check ("is the worker this process?"). */
export const guardHolder = (redis: Redis): Promise<string | null> => redis.get(KEYS.worker);
