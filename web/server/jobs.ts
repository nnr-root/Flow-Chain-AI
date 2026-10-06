import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, openSync, closeSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { maxJobs, roots } from "./config";
import { RUN_ID } from "@src/studio/commands";
import { ApiError } from "./http";

const run = promisify(execFile);

export const JOB_FILE = "job.json";
export const JOB_LOG = "job.log";
/** Written by the job's own shell when the CLI ends, so the result survives a restart of the web server. */
export const JOB_EXIT = "job.exit";
const LOCK_FILE = ".lock";

export type JobKind = "draft" | "generate" | "reroll" | "rerender";
export type Job = {
  id: string;
  kind: JobKind;
  /** CLI arguments (no secrets: keys live in .env, which only the CLI reads). */
  args: string[];
  pid: number;
  /** The process's start time (`ps -o lstart=`): a pid alone can be reused by an unrelated process after a crash or reboot. */
  procStart?: string;
  startedAt: string;
  approvedUsd?: number;
  stoppedAt?: string;
};
export type JobState =
  | { state: "running" }
  | { state: "ended"; exitCode: number }
  /** Stopped by the user, or its process vanished without recording an exit code (crash, reboot). */
  | { state: "stopped" | "interrupted" };
export type JobView = Job & JobState;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When a process started, as `ps` reports it; undefined if it cannot be told. */
function procStartOf(pid: number): string | undefined {
  try {
    // LC_ALL=C: `lstart` is written in the locale's language, and a server restarted under another one must still match
    const env = { ...process.env, LC_ALL: "C" };
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The job's own process is alive: the pid exists and, when its start time was recorded, is still the same process. */
function jobAlive(job: Job): boolean {
  return alive(job.pid) && (job.procStart === undefined || procStartOf(job.pid) === job.procStart);
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new ApiError("not_found", `no run ${runId}`);
}

function exitCodeOf(dir: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, JOB_EXIT), "utf8").trim();
  } catch {
    return undefined;
  }
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

export function readJob(dir: string): JobView | null {
  let job: Job;
  try {
    job = JSON.parse(readFileSync(join(dir, JOB_FILE), "utf8")) as Job;
  } catch {
    return null;
  }
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

/** The CLI as a command line: the real one through tsx, or the replacement tests provide. */
export function cliCommand(args: string[]): { cmd: string; argv: string[] } {
  const { repo, cli } = roots();
  return cli
    ? { cmd: process.execPath, argv: [cli, ...args] }
    : { cmd: process.execPath, argv: ["--import", "tsx", join(repo, "src/cli.ts"), ...args] };
}

/**
 * Runs whose start is in flight: job.json is written only after the spawn, so these count as active meanwhile.
 * Kept on `globalThis`: a dev-server recompile loads this module again, and a second set would let one run start twice.
 */
const STARTING = Symbol.for("flowchain.studio.starting");
const shared = globalThis as { [STARTING]?: Set<string> };
const starting = (shared[STARTING] ??= new Set<string>());

/**
 * The environment the CLI runs in: the studio's own, without what Next sets for itself (`NODE_ENV`,
 * `NODE_OPTIONS`, `NEXT_*`, `__NEXT_*`), which would change how the CLI and its renderer behave.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name === "NODE_ENV" || name === "NODE_OPTIONS" || name.startsWith("NEXT_") || name.startsWith("__NEXT_")) continue;
    env[name] = value;
  }
  env.RUNS_DIR = roots().runs;
  // Next's types declare NODE_ENV as always present; here it is left out on purpose
  return env as NodeJS.ProcessEnv;
}

/**
 * Starts the CLI detached, in its own process group, so it outlives the web server. Its output goes to the
 * run's job.log and its exit code to job.exit. One job per run, and at most `STUDIO_MAX_JOBS` at once.
 */
export async function startJob(runId: string, kind: JobKind, args: string[], approvedUsd?: number): Promise<JobView> {
  assertRunId(runId);
  const dir = join(roots().runs, runId);
  // check and claim without an await in between: two requests for one run (a double click) must not both pass
  if (starting.has(runId) || readJob(dir)?.state === "running" || existsSync(join(dir, LOCK_FILE))) {
    throw new ApiError("job_active", `run ${runId} is already working`, "wait for it to finish, or stop it first");
  }
  if (liveJobs() + starting.size >= maxJobs()) {
    throw new ApiError("busy", `${maxJobs()} jobs are already running`, "wait for one to finish (a render uses most of the machine)");
  }
  starting.add(runId);
  try {
    await mkdir(dir, { recursive: true });
    await rm(join(dir, JOB_EXIT), { force: true });
    const { cmd, argv } = cliCommand(args);
    const log = openSync(join(dir, JOB_LOG), "a");
    try {
      // the shell runs the CLI, then records how it ended; `"$@"` keeps every argument intact (no quoting to get wrong)
      const child = spawn("/bin/sh", ["-c", '"$@"; echo $? > "$JOB_EXIT_FILE"', "flowchain-job", cmd, ...argv], {
        cwd: roots().repo,
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...childEnv(), JOB_EXIT_FILE: join(dir, JOB_EXIT) },
      });
      if (child.pid === undefined) throw new Error("could not start the job process");
      child.unref();
      const job: Job = {
        id: `${Date.now().toString(36)}-${child.pid}`,
        kind,
        args,
        pid: child.pid,
        procStart: procStartOf(child.pid),
        startedAt: new Date().toISOString(),
        approvedUsd,
      };
      await writeFile(join(dir, JOB_FILE), `${JSON.stringify(job, null, 2)}\n`);
      return { ...job, state: "running" };
    } finally {
      closeSync(log);
    }
  } finally {
    starting.delete(runId);
  }
}

/** Stops a run's live job: SIGTERM to its process group. The CLI removes its lock and stays resumable. */
export async function stopJob(runId: string): Promise<JobView> {
  assertRunId(runId);
  const dir = join(roots().runs, runId);
  const job = readJob(dir);
  if (!job || job.state !== "running") throw new ApiError("not_found", `run ${runId} has no running job`);
  const { state: _state, ...stored } = job;
  await writeFile(join(dir, JOB_FILE), `${JSON.stringify({ ...stored, stoppedAt: new Date().toISOString() }, null, 2)}\n`);
  try {
    process.kill(-job.pid, "SIGTERM");
  } catch {
    // already gone
  }
  return readJob(dir)!;
}

/**
 * What a run's lock says about the process that wrote it. A lock without a readable pid counts as live: the CLI
 * creates the file first and writes its pid into it afterwards.
 */
function lockState(dir: string): "none" | "live" | "dead" {
  let text: string;
  try {
    text = readFileSync(join(dir, LOCK_FILE), "utf8").trim();
  } catch {
    return "none";
  }
  const pid = /^\d+$/.test(text) ? Number(text) : 0;
  return pid > 0 && !alive(pid) ? "dead" : "live";
}

/** The run has a lock nobody holds any more (the CLI was killed hard) and no running job: the lock can be cleared. */
export function hasStaleLock(dir: string, job: JobView | null = readJob(dir)): boolean {
  return job?.state !== "running" && lockState(dir) === "dead";
}

/**
 * Removes a lock left behind by a hard kill. Only when no job of this run is alive and the process that wrote
 * the lock is gone: a live process's lock is what stops the same work being bought twice.
 */
export async function clearStaleLock(runId: string): Promise<void> {
  assertRunId(runId);
  const dir = join(roots().runs, runId);
  const lock = lockState(dir);
  if (lock === "none") return;
  if (lock === "live" || readJob(dir)?.state === "running") {
    throw new ApiError("job_active", `run ${runId} is still working`, "stop it first");
  }
  await rm(join(dir, LOCK_FILE), { force: true });
}

/** Runs a free, short CLI command (plan, draft-modes) and returns its JSON output. */
export async function cliJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await cliText(args)) as T;
}

/** Runs a free, short CLI command to its end and returns what it printed. */
export async function cliText(args: string[]): Promise<string> {
  const { cmd, argv } = cliCommand(args);
  try {
    const { stdout } = await run(cmd, argv, { cwd: roots().repo, env: childEnv(), timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new ApiError("validation", stderr?.split("\n").at(-1) || (err instanceof Error ? err.message : String(err)));
  }
}

/** The last lines of a run's job log, for a failure message or the progress panel. */
export async function logTail(runId: string, lines = 40): Promise<string[]> {
  assertRunId(runId);
  try {
    const text = await readFile(join(roots().runs, runId, JOB_LOG), "utf8");
    return text.trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}
