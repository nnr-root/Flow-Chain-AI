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
/** `stripe-event` carries the id of a Stripe event to fulfil; `stripe-customer` asks for the user's Stripe customer. */
export type QuickJobData = { args: string[]; userId?: string; runId?: string; reservationId?: string; eventId?: string };
export type QuickJobResult = { stdout: string };

const AMOUNT = /^\d+(\.\d+)?$/;
/** What a draft's command may carry after `run --draft --yes --run-id <id>`: each at most once, in any order. */
const DRAFT_VALUED = new Set([
  "--topic", "--aspect", "--scenes", "--mode", "--clips", "--budget", "--caption-style", "--transition", "--bgm-gain", "--sfx-gain",
  "--style", "--pin-modes", "--brand", "--bgm", "--hook", "--characters", "--seed", "--voice",
]);
const DRAFT_FLAGS = new Set(["--no-hook", "--no-sfx"]);
/** The kind of job each command is: the kind decides whether credit must be held, so it cannot be claimed freely. */
const KIND_OF: Record<string, JobKind> = { run: "draft", resume: "generate", reroll: "reroll", rerender: "rerender" };

/** The kind of job a command is, or undefined for something that is no job command. Never taken from the job's own word. */
export const commandKind = (args: unknown): JobKind | undefined =>
  Array.isArray(args) && typeof args[0] === "string" && Object.hasOwn(KIND_OF, args[0]) ? KIND_OF[args[0]] : undefined;

/**
 * What the worker agrees to run, whoever put the job in Redis. The provider keys live with the worker, so it
 * does not take the web's word for anything:
 *
 * - only the commands the studio sends, each for the job's own run, and of the kind the job says it is;
 * - a command that spends (`resume`, `reroll`) must have **exactly** the shape the studio builds, with one
 *   amount as both its budget and its cap. A command line reads the last of two `--cap`s; a check that read
 *   the first would approve one amount and run another, so nothing may be repeated or added;
 * - a draft may carry only the options a draft has, each once. It buys the script and nothing else.
 *
 * Returns why a job is refused, or nothing when it may run. How much a paid command may spend is its cap, which
 * the worker compares with the credit held for the job (a studio with accounts).
 */
export function refusal(queue: keyof typeof QUEUES, args: unknown, runId?: string, kind?: JobKind): string | undefined {
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === "string")) return "the job has no command";
  const list = args as string[];
  const [command] = list;
  // Quick commands are free and change no money. They carry the user they are run for without proof: whoever
  // can write to Redis can read any user's plan or change a draft's modes or look. Redis is reachable only by
  // the web app and the worker.
  if (queue === "quick") return ["plan", "draft-modes", "look"].includes(command) ? undefined : `"${command}" is not a quick command`;
  if (!Object.hasOwn(KIND_OF, command)) return `"${command}" is not a job command`;
  if (kind !== undefined && KIND_OF[command] !== kind) return `a ${kind} job may not run "${command}"`;
  // the job's run is the command's run: one job per run means nothing if a job may work on another
  const other = "the command is for another run than the job";
  if (command === "rerender") return runId !== undefined && list[1] !== runId ? other : undefined;
  if (command === "resume") {
    if (list.includes("--yes")) return '"resume" may not be started with --yes';
    if (runId !== undefined && list[1] !== runId) return other;
    const ok = list.length === 6 && list[2] === "--budget" && list[4] === "--cap" && AMOUNT.test(list[3]) && list[3] === list[5];
    return ok ? undefined : '"resume" must be: resume <run> --budget <usd> --cap <the same usd>';
  }
  if (command === "reroll") {
    if (list.includes("--yes")) return '"reroll" may not be started with --yes';
    if (runId !== undefined && list[1] !== runId) return other;
    const ok =
      list.length === 10 && list[2] === "--scene" && /^\d+$/.test(list[3]) && list[4] === "--stage" && /^[a-z]+$/.test(list[5]) &&
      list[6] === "--budget" && list[8] === "--cap" && AMOUNT.test(list[7]) && list[7] === list[9];
    return ok ? undefined : '"reroll" must be: reroll <run> --scene <n> --stage <name> --budget <usd> --cap <the same usd>';
  }
  // run: only ever as a draft
  if (!list.includes("--draft")) return "a run may only be started as a draft";
  if (list[1] !== "--draft" || list[2] !== "--yes" || list[3] !== "--run-id") return "a draft must begin: run --draft --yes --run-id <run>";
  if (runId !== undefined && list[4] !== runId) return other;
  const seen = new Set<string>();
  for (let i = 5; i < list.length; i++) {
    const option = list[i];
    if (seen.has(option)) return `a draft may not repeat ${option}`;
    seen.add(option);
    if (DRAFT_FLAGS.has(option)) continue;
    // an option's value is whatever follows it, also when it looks like an option: that is how the CLI reads it
    if (!DRAFT_VALUED.has(option) || i + 1 >= list.length) return `a draft may not carry ${option}`;
    i++;
  }
  return undefined;
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
