import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RUN_ID } from "@src/studio/commands";
import { roots } from "../config";
import { ApiError } from "../http";
import { JOB_EXIT, JOB_FILE, JOB_LOG, type Job, type JobKind, LOCK_FILE } from "./types";

/*
 * Running the CLI and keeping a run's job files: shared by the local runner (the web server's own children) and
 * the queue's worker, so a job looks the same on disk whoever started it.
 */

const run = promisify(execFile);

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When a process started, as `ps` reports it; undefined if it cannot be told. */
export function procStartOf(pid: number): string | undefined {
  try {
    // LC_ALL=C: `lstart` is written in the locale's language, and a server restarted under another one must still match
    const env = { ...process.env, LC_ALL: "C" };
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The job's own process is alive: the pid exists and, when its start time was recorded, is still the same process. */
export function jobAlive(job: Job): boolean {
  return job.pid !== undefined && alive(job.pid) && (job.procStart === undefined || procStartOf(job.pid) === job.procStart);
}

export function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new ApiError("not_found", `no run ${runId}`);
}

export const runFolder = (runId: string): string => {
  assertRunId(runId);
  return join(roots().runs, runId);
};

/** The run's last job as recorded on disk, or null when it never had one. */
export function readJobRecord(dir: string): Job | null {
  try {
    return JSON.parse(readFileSync(join(dir, JOB_FILE), "utf8")) as Job;
  } catch {
    return null;
  }
}

export const writeJobRecord = (dir: string, job: Job): Promise<void> => writeFile(join(dir, JOB_FILE), `${JSON.stringify(job, null, 2)}\n`);

/** The exit code the job's shell recorded; undefined while the file is missing, empty or half-written. */
export function exitCodeOf(dir: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, JOB_EXIT), "utf8").trim();
  } catch {
    return undefined;
  }
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/**
 * What a run's lock says about the process that wrote it. A lock without a readable pid counts as live: the CLI
 * creates the file first and writes its pid into it afterwards.
 */
export function lockState(dir: string): "none" | "live" | "dead" {
  let text: string;
  try {
    text = readFileSync(join(dir, LOCK_FILE), "utf8").trim();
  } catch {
    return "none";
  }
  const pid = /^\d+$/.test(text) ? Number(text) : 0;
  return pid > 0 && !alive(pid) ? "dead" : "live";
}

/** The CLI as a command line: the real one through tsx, or the replacement tests provide. */
export function cliCommand(args: string[]): { cmd: string; argv: string[] } {
  const { repo, cli } = roots();
  return cli
    ? { cmd: process.execPath, argv: [cli, ...args] }
    : { cmd: process.execPath, argv: ["--import", "tsx", join(repo, "src/cli.ts"), ...args] };
}

/**
 * The environment the CLI runs in: this process's own, without what Next sets for itself (`NODE_ENV`,
 * `NODE_OPTIONS`, `NEXT_*`, `__NEXT_*`), which would change how the CLI and its renderer behave, and without
 * what is the server's own (`SUPABASE_*`, `REDIS_URL`, `WORKER_*`): the CLI makes videos and has no business
 * with accounts, credit or the queue.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name === "NODE_ENV" || name === "NODE_OPTIONS" || name.startsWith("NEXT_") || name.startsWith("__NEXT_")) continue;
    if (name.startsWith("SUPABASE_") || name.startsWith("WORKER_") || name === "REDIS_URL") continue;
    env[name] = value;
  }
  env.RUNS_DIR = roots().runs;
  // Next's types declare NODE_ENV as always present; here it is left out on purpose
  return env as NodeJS.ProcessEnv;
}

/**
 * Starts the CLI for a run in its own process group, with its output appended to the run's job.log and its exit
 * code written to job.exit by the shell around it, and records the job in job.json. The caller decides whether
 * to wait for the child (the worker) or let it go (the local runner).
 */
export async function spawnCli(runId: string, kind: JobKind, args: string[], approvedUsd?: number): Promise<{ job: Job; child: ChildProcess }> {
  const dir = runFolder(runId);
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
    const job: Job = {
      id: `${Date.now().toString(36)}-${child.pid}`,
      kind,
      args,
      pid: child.pid,
      procStart: procStartOf(child.pid),
      startedAt: new Date().toISOString(),
      approvedUsd,
    };
    await writeJobRecord(dir, job);
    return { job, child };
  } finally {
    closeSync(log);
  }
}

/** Records that the job was stopped on purpose and ends its process group. The CLI removes its lock and stays resumable. */
export async function stopProcess(dir: string, job: Job): Promise<void> {
  await writeJobRecord(dir, { ...job, stoppedAt: new Date().toISOString() });
  if (job.pid === undefined) return;
  try {
    process.kill(-job.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

/** Runs a free, short CLI command to its end and returns what it printed; throws its last error line. */
export async function runShort(args: string[]): Promise<string> {
  const { cmd, argv } = cliCommand(args);
  try {
    const { stdout } = await run(cmd, argv, { cwd: roots().repo, env: childEnv(), timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr?.split("\n").at(-1) || (err instanceof Error ? err.message : String(err)));
  }
}

/** The last lines of a run's job log, for a failure message or the progress panel. */
export async function logTail(runId: string, lines = 40): Promise<string[]> {
  const dir = runFolder(runId);
  try {
    const text = await readFile(join(dir, JOB_LOG), "utf8");
    return text.trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}
