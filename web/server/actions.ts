import { existsSync } from "node:fs";
import { newRunId } from "@src/manifest/store";
import type { PlanJson } from "@src/studio/commands";
import { statusOf } from "@src/studio/status";
import { DRAFT_CAP_USD, newTenantRun, reserve } from "./credit";
import { ApiError } from "./http";
import { round4 } from "@/lib/credit";
import { cliJson, cliText, jobReady, type JobView, releaseJob, startJob, studioHealth, viewJob } from "./jobs";
import { requireManifest } from "./runs";
import { multiTenant } from "./tenant";
import { draftArgs, kitDir, type Look, modesArg, musicPath, type NewVideo, rerenderArgs } from "./schemas";

/** The run has a job that is running or waiting its turn. */
async function busy(runId: string): Promise<boolean> {
  const state = (await viewJob(runId))?.state;
  return state === "running" || state === "queued";
}

type RerollTarget = { scene: number; stage: string };

/** Buys the script for a new run and stops there. The keys a run needs must be set first. */
export async function createDraft(input: NewVideo): Promise<{ runId: string; job: JobView }> {
  const { missing, queue } = await studioHealth();
  // with the queue the keys are the worker's: when it cannot be asked, nothing is known about them
  if (queue.mode === "queue" && !(queue.redis && queue.worker)) {
    throw new ApiError(queue.redis ? "worker_offline" : "queue_unavailable", queue.redis ? "the worker is offline" : "the job queue is unavailable", "nothing was started; try again in a moment");
  }
  const unset = missing;
  if (unset.length > 0) {
    const where = queue.mode === "queue" ? "set them in .env or deploy/server.env and run npm run server:setup again" : "add them to .env in the repository, then try again";
    throw new ApiError("missing_keys", `${queue.mode === "queue" ? "the worker has no" : "not set in .env:"} ${unset.join(", ")}`, where);
  }
  if (input.brandKit && !existsSync(kitDir(input.brandKit))) throw new ApiError("validation", `brandKit: no kit "${input.brandKit}"`);
  if (input.music && !existsSync(musicPath(input.music))) throw new ApiError("validation", `music: no track ${input.music}`);
  if (multiTenant()) {
    // the run is registered as the user's, and the script's cost is held from their credit, before anything is queued
    const runId = await newTenantRun(input.topic);
    return { runId, job: await startPaid(runId, "draft", draftArgs(input, runId), DRAFT_CAP_USD) };
  }
  const runId = newRunId();
  return { runId, job: await startJob(runId, "draft", draftArgs(input, runId)) };
}

/**
 * Starts a job that spends. With accounts its cap is first held from the user's credit — after everything that
 * can be known beforehand was checked (a worker is there, the run is free, the user has room in line), so a
 * refusal on those grounds holds nothing. If the job still cannot be queued, the credit is given back at once.
 */
async function startPaid(runId: string, kind: "draft" | "generate" | "reroll", args: string[], capUsd: number): Promise<JobView> {
  if (!multiTenant()) return startJob(runId, kind, args, kind === "draft" ? undefined : capUsd);
  await jobReady(runId);
  const reservationId = await reserve(runId, kind, capUsd);
  try {
    return await startJob(runId, kind, args, capUsd, { reservationId });
  } catch (err) {
    await releaseJob(runId, reservationId);
    throw err;
  }
}

/** What an action would cost right now, from the CLI's own planner; nothing is changed. */
export async function price(runId: string, what: { reroll?: RerollTarget; modes?: Array<1 | 2 | null> } = {}): Promise<PlanJson> {
  await requireManifest(runId);
  return cliJson<PlanJson>([
    "plan", runId, "--json",
    ...(what.reroll ? ["--reroll", `${what.reroll.scene}:${what.reroll.stage}`] : []),
    ...(what.modes ? ["--modes", modesArg(what.modes)] : []),
  ]);
}

/** Pins a draft's scene modes and returns the new price. */
export async function setModes(runId: string, modes: Array<1 | 2 | null>): Promise<PlanJson> {
  const m = await requireManifest(runId);
  if (!statusOf(m).draft) throw new ApiError("not_draft", "media was already bought for this run, so its modes are fixed");
  if (m.request.modes) throw new ApiError("not_draft", "this run was created with fixed modes");
  if (await busy(runId)) throw new ApiError("job_active", `run ${runId} is working`);
  await cliJson(["draft-modes", runId, "--modes", modesArg(modes), "--json"]);
  return price(runId);
}

/** The estimate the user approved must still cover the plan; otherwise nothing starts and the new figure goes back. */
async function assertApproved(runId: string, approvedUsd: number, reroll?: RerollTarget): Promise<void> {
  const plan = await price(runId, { reroll });
  // a plan without a number cannot be compared with anything: nothing may start on it
  if (typeof plan.totalUsd !== "number" || !Number.isFinite(plan.totalUsd)) {
    throw new ApiError("internal", "the CLI's plan has no total, so nothing was started");
  }
  // both are 4-decimal sums the CLI printed, so they compare exactly
  if (plan.totalUsd > approvedUsd) {
    throw new ApiError(
      "estimate_changed",
      `the estimate is now $${plan.totalUsd.toFixed(2)}, more than the $${approvedUsd.toFixed(2)} that was approved`,
      "check the new estimate and confirm again",
      { totalUsd: plan.totalUsd },
    );
  }
}

/**
 * Continues a run (a draft's first generation, a failed run, one that needs approval). The approved amount goes
 * to the CLI twice: as `--budget`, so it does not ask, and as `--cap`, the ceiling on what the job spends in total.
 */
export async function generate(runId: string, approvedUsd: number): Promise<JobView> {
  // one figure, to four decimals, for the plan check, the credit held and the command's cap
  const approved = round4(approvedUsd);
  await assertApproved(runId, approved);
  // no --yes: when a later checkpoint prices the rest above the approved amount, the CLI stops (exit 2) instead of spending
  return startPaid(runId, "generate", ["resume", runId, "--budget", String(approved), "--cap", String(approved)], approved);
}

export async function reroll(runId: string, target: RerollTarget, approvedUsd: number): Promise<JobView> {
  const approved = round4(approvedUsd);
  await assertApproved(runId, approved, target);
  return startPaid(runId, "reroll", ["reroll", runId, "--scene", String(target.scene), "--stage", target.stage, "--budget", String(approved), "--cap", String(approved)], approved);
}

/** Stores a look in the run without rendering: how a draft (or any unfinished run) keeps the look its preview shows. */
export async function saveLook(runId: string, look: Look): Promise<void> {
  await requireManifest(runId);
  if (look.brandKit && !existsSync(kitDir(look.brandKit))) throw new ApiError("validation", `brandKit: no kit "${look.brandKit}"`);
  if (await busy(runId)) throw new ApiError("job_active", `run ${runId} is working`);
  await cliText(rerenderArgs(runId, look, "look"));
}

/** Re-renders with a new look: free, and the CLI itself refuses if anything paid would have to run. */
export async function rerender(runId: string, look: Look): Promise<JobView> {
  await requireManifest(runId);
  if (look.brandKit && !existsSync(kitDir(look.brandKit))) throw new ApiError("validation", `brandKit: no kit "${look.brandKit}"`);
  return startJob(runId, "rerender", rerenderArgs(runId, look), 0);
}
