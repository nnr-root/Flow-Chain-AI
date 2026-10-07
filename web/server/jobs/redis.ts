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
export type RunJobData = { runId: string; kind: JobKind; args: string[]; approvedUsd?: number; enqueuedAt: string; token: string };
export type RunJobResult = { exitCode: number | null; stopped?: boolean };
/** Job names on the quick queue: `cli` runs a free command, `health` reports which keys the worker has. */
export type QuickJobData = { args: string[] };
export type QuickJobResult = { stdout: string };

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
