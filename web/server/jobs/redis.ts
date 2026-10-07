import { Redis } from "ioredis";
import type { JobKind } from "./types";

/* What the web app and the worker agree on: queue names, keys, job shapes and the options every job gets. */

export const QUEUES = { runs: "flowchain-runs", quick: "flowchain-quick" } as const;
export const KEYS = {
  /** Held by the one worker and renewed while it lives: the single-worker guard and its heartbeat. */
  worker: "flowchain:worker",
  /**
   * The run ids whose CLI the worker has running right now (a JSON list), rewritten with every renewal of the
   * guard. After a long Redis outage the queue can forget a job that is still working; the worker does not.
   */
  held: "flowchain:worker:runs",
  /** Pub/sub channel: a run id whose running job should be stopped. */
  cancel: "flowchain:cancel",
} as const;

/**
 * Every job runs once. A retry of a job that already bought something is how money is spent twice, so a failed
 * job stays failed until the user resumes the run. Finished jobs leave Redis at once: their history is the
 * run's own job files, and a run's job id (its run id) must be free for the next action.
 */
export const JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: true } as const;

/** `token` is unique per request: the queue keeps the first job for a run id, and the token tells whose it is. */
export type RunJobData = {
  runId: string; kind: JobKind; args: string[]; approvedUsd?: number; enqueuedAt: string; token: string;
  /** A studio with accounts: whose job this is, and the credit held for it (paid kinds). */
  userId?: string; reservationId?: string;
};
export type RunJobResult = { exitCode: number | null; stopped?: boolean };
/** Job names on the quick queue: `cli` runs a free command, `health` reports which keys the worker has. */
/** `restore` (a studio with accounts) brings `runId`'s folder back from the bucket. */
export type QuickJobData = { args: string[]; userId?: string; runId?: string };
export type QuickJobResult = { stdout: string };

/**
 * What the worker agrees to run, whoever put the job in Redis: the commands the studio sends and no others.
 * The provider keys live with the worker, so it does not take the web's word that a job is one of these.
 * Returns why a job is refused, or nothing when it may run. This limits what can be run, not how much a run
 * may spend: the amounts are the web's to approve.
 */
export function refusal(queue: keyof typeof QUEUES, args: unknown, runId?: string): string | undefined {
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === "string")) return "the job has no command";
  const [command] = args as string[];
  if (queue === "quick") return ["plan", "draft-modes", "look"].includes(command) ? undefined : `"${command}" is not a quick command`;
  // a draft buys only the script and says so with --yes; everything else spends up to an approved amount and must stop to ask
  // the job's run is the command's run: one job per run means nothing if a job may work on another
  const target = command === "run" ? args[args.indexOf("--run-id") + 1] : args[1];
  if (runId !== undefined && (target !== runId || (command === "run" && !args.includes("--run-id")))) return "the command is for another run than the job";
  if (command === "run") return args.includes("--draft") ? undefined : "a run may only be started as a draft";
  if (command === "rerender") return undefined;
  if (command === "resume" || command === "reroll") return args.includes("--yes") ? `"${command}" may not be started with --yes` : undefined;
  return `"${command}" is not a job command`;
}

/** How long the web waits for a quick job before telling the user the worker is busy or offline. */
export const QUICK_WAIT_MS = 60_000;

export const redisUrl = (): string | undefined => process.env.REDIS_URL?.trim() || undefined;

/**
 * A connection for a consumer (worker, event listener): BullMQ's blocking commands need unlimited retries, and
 * commands issued while Redis is away wait for it to come back.
 */
export const consumerConnection = (url: string): Redis => new Redis(url, { maxRetriesPerRequest: null });

/**
 * A connection for the web app's own commands: when Redis is away they fail at once instead of queueing up, so
 * a click answers "the queue is unavailable" rather than hanging.
 */
export const clientConnection = (url: string): Redis =>
  new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3000, retryStrategy: (times) => Math.min(times * 200, 2000) });
