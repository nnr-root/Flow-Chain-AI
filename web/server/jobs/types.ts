import type { Health } from "../config";

export const JOB_FILE = "job.json";
export const JOB_LOG = "job.log";
/** Written by the job's own shell when the CLI ends, so the result survives a restart of whatever started it. */
export const JOB_EXIT = "job.exit";
export const LOCK_FILE = ".lock";

export type JobKind = "draft" | "generate" | "reroll" | "rerender";
export type Job = {
  id: string;
  kind: JobKind;
  /** CLI arguments (no secrets: keys live in the environment of whatever runs the CLI). */
  args: string[];
  /** The job's process; absent while the job is only waiting in the queue. */
  pid?: number;
  /** The process's start time (`ps -o lstart=`): a pid alone can be reused by an unrelated process after a crash or reboot. */
  procStart?: string;
  /** When the job started, or was queued while it waits. */
  startedAt: string;
  approvedUsd?: number;
  stoppedAt?: string;
};
export type JobState =
  /** Waiting in the queue; `position` 1 is next. */
  | { state: "queued"; position: number }
  | { state: "running" }
  | { state: "ended"; exitCode: number }
  /** Stopped by the user, or its process vanished without recording an exit code (crash, reboot). */
  | { state: "stopped" | "interrupted" };
export type JobView = Job & JobState;

/** Where jobs run: in this process's children, or through the queue (with what is known about its two ends). */
export type QueueHealth = { mode: "local" } | { mode: "queue"; redis: boolean; worker: boolean };
export type StudioHealth = Health & { queue: QueueHealth };

/**
 * Everything the studio does through the CLI. Two implementations: `local` starts the CLI as a detached child of
 * the web server (development, tests); `queue` hands the work to the worker through Redis (the server).
 */
export interface JobRunner {
  readonly mode: "local" | "queue";
  /** Starts a run's job, or puts it in line. One job per run. */
  /** `reservationId`: the credit held for this job (a studio with accounts; paid kinds only). */
  start(runId: string, kind: JobKind, args: string[], approvedUsd?: number, opts?: { reservationId?: string }): Promise<JobView>;
  /** Ends a running job (the CLI stays resumable) or takes a waiting one out of the line. */
  stop(runId: string): Promise<JobView>;
  view(runId: string): Promise<JobView | null>;
  /** Runs a free, short CLI command (plan, draft-modes, look) to its end and returns what it printed. */
  cliText(args: string[]): Promise<string>;
  health(): Promise<StudioHealth>;
  /** The run's lock was left by a process that is gone and nothing of the run is running. */
  staleLock(runId: string, job: JobView | null): Promise<boolean>;
  clearStaleLock(runId: string): Promise<void>;
  /** Brings a run's folder back from the bucket (a studio with accounts); nothing to do where runs only live on disk. */
  restore(runId: string): Promise<void>;
  /**
   * Whether a job for this run could be started right now (the worker is there, the run has no job, the user
   * has room in line). Asked before credit is held, so that what can be known beforehand does not hold it.
   */
  ready(runId: string): Promise<void>;
  /** Credit was held for a job that then could not be queued: has it given back at once. Never throws. */
  release(runId: string): Promise<void>;
}
