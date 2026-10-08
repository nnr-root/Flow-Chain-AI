import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { health, maxJobs, roots } from "../config";
import { ApiError } from "../http";
import { exitCodeOf, jobAlive, lockState, readJobRecord, runFolder, runShort, spawnCli, stopProcess } from "./run-cli";
import { type JobRunner, type JobView, LOCK_FILE } from "./types";

/** The run's last job with its state, judged from this machine's processes: the local runner's view. */
export function readJob(dir: string): JobView | null {
  const job = readJobRecord(dir);
  if (!job) return null;
  // an empty or half-written exit file (read while the shell writes it) is not an exit yet: the process decides
  const code = exitCodeOf(dir);
  if (code !== undefined) return { ...job, state: "ended", exitCode: code };
  if (jobAlive(job)) return { ...job, state: "running" };
  return { ...job, state: job.stoppedAt ? "stopped" : "interrupted" };
}

/** Live jobs across every run: the machine limit counts them. */
export function liveJobs(): number {
  const { runs } = roots();
  if (!existsSync(runs)) return 0;
  return readdirSync(runs).filter((id) => readJob(join(runs, id))?.state === "running").length;
}

/** The run has a lock nobody holds any more (the CLI was killed hard) and no running job: the lock can be cleared. */
export function hasStaleLock(dir: string, job: JobView | null = readJob(dir)): boolean {
  return job?.state !== "running" && lockState(dir) === "dead";
}

/**
 * Runs whose start is in flight: job.json is written only after the spawn, so these count as active meanwhile.
 * Kept on `globalThis`: a dev-server recompile loads this module again, and a second set would let one run start twice.
 */
const STARTING = Symbol.for("flowchain.studio.starting");
const shared = globalThis as { [STARTING]?: Set<string> };
const starting = (shared[STARTING] ??= new Set<string>());

/**
 * 3.1's runner: the CLI is a detached child of the web server, so it outlives it. One job per run, and at most
 * `STUDIO_MAX_JOBS` at once (a further start is refused, not queued).
 */
export const localRunner: JobRunner = {
  mode: "local",

  async start(runId, kind, args, approvedUsd) {
    const dir = runFolder(runId);
    // check and claim without an await in between: two requests for one run (a double click) must not both pass
    if (starting.has(runId) || readJob(dir)?.state === "running" || existsSync(join(dir, LOCK_FILE))) {
      throw new ApiError("job_active", `run ${runId} is already working`, "wait for it to finish, or stop it first");
    }
    if (liveJobs() + starting.size >= maxJobs()) {
      throw new ApiError("busy", `${maxJobs()} jobs are already running`, "wait for one to finish (a render uses most of the machine)");
    }
    starting.add(runId);
    try {
      const { job, child } = await spawnCli(runId, kind, args, approvedUsd);
      child.unref();
      return { ...job, state: "running" };
    } finally {
      starting.delete(runId);
    }
  },

  async stop(runId) {
    const dir = runFolder(runId);
    const job = readJob(dir);
    if (!job || job.state !== "running") throw new ApiError("not_found", `run ${runId} has no running job`);
    const { state: _state, ...stored } = job;
    await stopProcess(dir, stored);
    return readJob(dir)!;
  },

  async view(runId) {
    return readJob(runFolder(runId));
  },

  async cliText(args) {
    try {
      return await runShort(args);
    } catch (err) {
      throw new ApiError("validation", err instanceof Error ? err.message : String(err));
    }
  },

  async health() {
    return { ...health(), queue: { mode: "local" } };
  },

  async restore() {},
  async ready() {},
  async release() {},
  // payments need the worker: it alone may turn one into credit
  async stripeEvent() {
    throw new ApiError("billing_unavailable", "this studio takes no payments");
  },
  async stripeCustomer() {
    throw new ApiError("billing_unavailable", "this studio takes no payments");
  },

  async staleLock(runId, job) {
    return hasStaleLock(runFolder(runId), job);
  },

  /**
   * Removes a lock left behind by a hard kill. Only when no job of this run is alive and the process that wrote
   * the lock is gone: a live process's lock is what stops the same work being bought twice.
   */
  async clearStaleLock(runId) {
    const dir = runFolder(runId);
    const lock = lockState(dir);
    if (lock === "none") return;
    if (lock === "live" || readJob(dir)?.state === "running") {
      throw new ApiError("job_active", `run ${runId} is still working`, "stop it first");
    }
    await rm(join(dir, LOCK_FILE), { force: true });
  },
};
