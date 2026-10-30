import type { IdeasResult } from "@/lib/ideas";
import { ideasPriceUsd } from "@/lib/ideas";
import { ApiError } from "./http";
import { newIdeaRequest, reserve } from "./credit";
import { ideasJob, releaseJob, studioHealthRaw } from "./jobs";
import { ideasArgs, type IdeasInput } from "./schemas";
import { multiTenant, userDb } from "./tenant";

/** A click on "Suggest a topic": the price is held first (a studio with accounts), the worker asks, the price is kept or returned. */
export async function suggestIdeas(input: IdeasInput): Promise<IdeasResult> {
  const health = await studioHealthRaw();
  if (!health.ideas) throw new ApiError("not_found", "not found");
  if (!multiTenant()) return JSON.parse(await ideasJob(ideasArgs(input))) as IdeasResult;
  const price = ideasPriceUsd();
  if (price === undefined) throw new ApiError("not_found", "not found");
  // (nothing in the database caps hidden requests: a user without credit could register one per click; review of Task 1, Minor 3)
  const today = await userDb().from("runs").select("id").eq("state", "ideas").gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
  if (today.error) throw new Error(today.error.message);
  if ((today.data ?? []).length >= 50) throw new ApiError("too_many_jobs", "too many suggestions were asked for today", "try again tomorrow");
  const runId = await newIdeaRequest();
  const reservationId = await reserve(runId, "ideas", price);
  try {
    return JSON.parse(await ideasJob(ideasArgs(input, price), { runId, reservationId })) as IdeasResult;
  } catch (err) {
    // the worker settles a failed call itself; this covers a call that never reached it (a settled hold is not touched twice)
    await releaseJob(runId, reservationId);
    throw err instanceof ApiError ? err : new ApiError("ideas_failed", "no ideas could be made this time", "your credit was returned");
  }
}
