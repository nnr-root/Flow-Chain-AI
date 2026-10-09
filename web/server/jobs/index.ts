import { localRunner } from "./local";
import { queueRunner } from "./queue";
import { multiTenant } from "@/lib/supabase/settings";
import { redisUrl } from "./redis";
import type { JobKind, JobRunner, JobView, StudioHealth } from "./types";
import { NOT_READY, publicLog } from "@/lib/engines";

export { hasStaleLock, liveJobs, readJob } from "./local";
import { logTail } from "./run-cli";
export { childEnv, logTail } from "./run-cli";
/**
 * The end of a run's job output as a page or an API answer may show it: the pipeline's words as they are in the
 * owner's own studio, and none that say how the studio is built in one with accounts (phase 5 spec §7). Anything
 * that shows a job's output to a browser goes through this, not through `logTail`.
 */
export const shownLog = async (runId: string): Promise<string[]> => (multiTenant() ? publicLog(await logTail(runId)) : logTail(runId));
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
export const releaseJob = (runId: string, reservationId: string): Promise<void> => runner().release(runId, reservationId);
export const stopJob = (runId: string): Promise<JobView> => runner().stop(runId);
export const viewJob = (runId: string): Promise<JobView | null> => runner().view(runId);
export const clearStaleLock = (runId: string): Promise<void> => runner().clearStaleLock(runId);
/** Everything about the studio's readiness, with the names of the settings that are missing: for the server's own decisions. */
export const studioHealthRaw = (): Promise<StudioHealth> => runner().health();
/** What a page or an API answer is given: in a studio with accounts, that something is missing and not what (phase 5 spec §7). */
export const studioHealth = async (): Promise<StudioHealth> => forCustomers(await studioHealthRaw(), multiTenant());
export const forCustomers = (health: StudioHealth, accounts: boolean): StudioHealth =>
  accounts && health.missing.length > 0 ? { ...health, missing: [NOT_READY] } : health;

/** Runs a free, short CLI command to its end and returns what it printed. */
export const cliText = (args: string[]): Promise<string> => runner().cliText(args);

/** Runs a free, short CLI command (plan, draft-modes) and returns its JSON output. */
export async function cliJson<T>(args: string[]): Promise<T> {
  return JSON.parse(await cliText(args)) as T;
}
