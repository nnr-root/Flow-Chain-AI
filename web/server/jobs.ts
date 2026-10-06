import { execFile, spawn } from "node:child_process";
import { existsSync, openSync, closeSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { maxJobs, roots } from "./config";
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

export function readJob(dir: string): JobView | null {
  let job: Job;
  try {
    job = JSON.parse(readFileSync(join(dir, JOB_FILE), "utf8")) as Job;
  } catch {
    return null;
  }
  const exit = join(dir, JOB_EXIT);
  if (existsSync(exit)) {
    const code = Number(readFileSync(exit, "utf8").trim());
    return { ...job, state: "ended", exitCode: Number.isInteger(code) ? code : 1 };
  }
  if (alive(job.pid)) return { ...job, state: "running" };
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

const childEnv = () => ({ ...process.env, RUNS_DIR: roots().runs });

/**
 * Starts the CLI detached, in its own process group, so it outlives the web server. Its output goes to the
 * run's job.log and its exit code to job.exit. One job per run, and at most `STUDIO_MAX_JOBS` at once.
 */
export async function startJob(runId: string, kind: JobKind, args: string[], approvedUsd?: number): Promise<JobView> {
  const dir = join(roots().runs, runId);
  if (readJob(dir)?.state === "running" || existsSync(join(dir, LOCK_FILE))) {
    throw new ApiError("job_active", `run ${runId} is already working`, "wait for it to finish, or stop it first");
  }
  if (liveJobs() >= maxJobs()) {
    throw new ApiError("busy", `${maxJobs()} jobs are already running`, "wait for one to finish (a render uses most of the machine)");
  }
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
    const job: Job = { id: `${Date.now().toString(36)}-${child.pid}`, kind, args, pid: child.pid, startedAt: new Date().toISOString(), approvedUsd };
    await writeFile(join(dir, JOB_FILE), `${JSON.stringify(job, null, 2)}\n`);
    return { ...job, state: "running" };
  } finally {
    closeSync(log);
  }
}

/** Stops a run's live job: SIGTERM to its process group. The CLI removes its lock and stays resumable. */
export async function stopJob(runId: string): Promise<JobView> {
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
 * Removes a lock left behind by a hard kill. Only when no job of this run is alive and the process that wrote
 * the lock is gone: a live process's lock is what stops the same work being bought twice.
 */
export async function clearStaleLock(runId: string): Promise<void> {
  const dir = join(roots().runs, runId);
  const lock = join(dir, LOCK_FILE);
  if (!existsSync(lock)) return;
  const pid = Number((await readFile(lock, "utf8")).trim());
  if (readJob(dir)?.state === "running" || (Number.isInteger(pid) && pid > 0 && alive(pid))) {
    throw new ApiError("job_active", `run ${runId} is still working`, "stop it first");
  }
  await rm(lock, { force: true });
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
  try {
    const text = await readFile(join(roots().runs, runId, JOB_LOG), "utf8");
    return text.trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}
