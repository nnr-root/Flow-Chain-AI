import { localRunner } from "./local";
import { queueRunner } from "./queue";
import { multiTenant } from "@/lib/supabase/settings";
import { redisUrl } from "./redis";
import type { JobKind, JobRunner, JobView, StudioHealth } from "./types";

export { hasStaleLock, liveJobs, readJob } from "./local";
export { childEnv, logTail } from "./run-cli";
export * from "./types";

/** The runner in use: the queue when a Redis address is configured (the server), otherwise this process's own children. */
export function runner(): JobRunner {
  const url = redisUrl();
  // with accounts the web must never run the CLI itself: it holds no provider keys and no key to settle credit
  if (!url && multiTenant()) throw new Error("a studio with accounts (SUPABASE_URL) needs the job queue: set REDIS_URL and run the worker");
  return url ? queueRunner(url) : localRunner;
}

export const startJob = (runId: string, kind: JobKind, args: string[], approvedUsd?: number, opts?: { reservationId?: string }): Promise<JobView> =>
  runner().start(runId, kind, args, approvedUsd, opts);
/** Before credit is held for a job: would it be accepted right now? */
export const jobReady = (runId: string): Promise<void> => runner().ready(runId);
/** After credit was held for a job that could not be queued. */
export const releaseJob = (runId: string): Promise<void> => runner().release(runId);
export const stopJob = (runId: string): Promise<JobView> => runner().stop(runId);
export const viewJob = (runId: string): Promise<JobView | null> => runner().view(runId);
export const clearStaleLock = (runId: string): Promise<void> => runner().clearStaleLock(runId);
export const studioHealth = (): Promise<StudioHealth> => runner().health();

/** Runs a free, short CLI command to its end and returns what it printed. */
export const cliText = (args: string[]): Promise<string> => runner().cliText(args);

/** Runs a free, short CLI command (plan, draft-modes) and returns its JSON output. */
export async function cliJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await cliText(args)) as T;
}
