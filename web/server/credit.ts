import { newRunId } from "@src/manifest/store";
import { ApiError } from "./http";
import { userDb } from "./tenant";

/* Credit, as the web sees it: it can hold a user's own credit for a job, through the user's own session. Settling is the worker's. */

export { DRAFT_CAP_USD } from "@/lib/credit";

const REFUSALS: Record<string, () => ApiError> = {
  not_found: () => new ApiError("not_found", "no such run"),
  job_active: () => new ApiError("job_active", "this run already has a paid job waiting or working", "wait for it to finish, or stop it first"),
  too_many_jobs: () => new ApiError("too_many_jobs", "you already have as many jobs waiting or working as one account may have", "wait for one to finish"),
  insufficient_credit: () => new ApiError("insufficient_credit", "your credit does not cover this", "see your balance on the account page"),
  too_many_runs: () => new ApiError("too_many_jobs", "too many videos were created today without being started", "try again tomorrow, or ask for the limit to be raised"),
  unauthenticated: () => new ApiError("unauthenticated", "sign in first"),
};

/** Registers a new run as the caller's and returns its id (ids are unique across all users; a taken one is tried again). */
export async function newTenantRun(topic: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newRunId();
    const { error } = await userDb().rpc("create_run", { p_id: id, p_topic: topic });
    if (!error) return id;
    if (error.message !== "run_exists") throw REFUSALS[error.message]?.() ?? new Error(`create_run: ${error.message}`);
  }
  throw new Error("could not find a free run id");
}

/**
 * Holds `capUsd` of the caller's credit for one paid job on their run and returns the reservation's id. The
 * database refuses when the balance is too low, the run is not theirs, or the run already has a paid job.
 */
export async function reserve(runId: string, kind: "draft" | "generate" | "reroll", capUsd: number): Promise<string> {
  const { data, error } = await userDb().rpc("reserve_credit", { p_run_id: runId, p_kind: kind, p_cap_usd: capUsd });
  if (error) throw REFUSALS[error.message]?.() ?? new Error(`reserve_credit: ${error.message}`);
  return data as string;
}
