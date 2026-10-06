import { existsSync } from "node:fs";
import { newRunId } from "@src/manifest/store";
import type { PlanJson } from "@src/studio/commands";
import { statusOf } from "@src/studio/status";
import { health } from "./config";
import { ApiError } from "./http";
import { cliJson, cliText, type JobView, readJob, startJob } from "./jobs";
import { requireManifest, runDir } from "./runs";
import { draftArgs, kitDir, type Look, modesArg, musicPath, type NewVideo, rerenderArgs } from "./schemas";

type RerollTarget = { scene: number; stage: string };

/** Buys the script for a new run and stops there. The keys the chosen provider needs must be set first. */
export async function createDraft(input: NewVideo): Promise<{ runId: string; job: JobView }> {
  const { missing } = health();
  const unset = [...missing.always, ...missing[input.provider]];
  if (unset.length > 0) {
    throw new ApiError("missing_keys", `not set in .env: ${unset.join(", ")}`, "add them to .env in the repository, then try again");
  }
  if (input.brandKit && !existsSync(kitDir(input.brandKit))) throw new ApiError("validation", `brandKit: no kit "${input.brandKit}"`);
  if (input.music && !existsSync(musicPath(input.music))) throw new ApiError("validation", `music: no track ${input.music}`);
  const runId = newRunId();
  return { runId, job: await startJob(runId, "draft", draftArgs(input, runId)) };
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
  if (readJob(runDir(runId))?.state === "running") throw new ApiError("job_active", `run ${runId} is working`);
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
  await assertApproved(runId, approvedUsd);
  // no --yes: when a later checkpoint prices the rest above the approved amount, the CLI stops (exit 2) instead of spending
  return startJob(runId, "generate", ["resume", runId, "--budget", String(approvedUsd), "--cap", String(approvedUsd)], approvedUsd);
}

export async function reroll(runId: string, target: RerollTarget, approvedUsd: number): Promise<JobView> {
  await assertApproved(runId, approvedUsd, target);
  return startJob(runId, "reroll", ["reroll", runId, "--scene", String(target.scene), "--stage", target.stage, "--budget", String(approvedUsd), "--cap", String(approvedUsd)], approvedUsd);
}

/** Stores a look in the run without rendering: how a draft (or any unfinished run) keeps the look its preview shows. */
export async function saveLook(runId: string, look: Look): Promise<void> {
  await requireManifest(runId);
  if (look.brandKit && !existsSync(kitDir(look.brandKit))) throw new ApiError("validation", `brandKit: no kit "${look.brandKit}"`);
  if (readJob(runDir(runId))?.state === "running") throw new ApiError("job_active", `run ${runId} is working`);
  await cliText(rerenderArgs(runId, look, "look"));
}

/** Re-renders with a new look: free, and the CLI itself refuses if anything paid would have to run. */
export async function rerender(runId: string, look: Look): Promise<JobView> {
  await requireManifest(runId);
  if (look.brandKit && !existsSync(kitDir(look.brandKit))) throw new ApiError("validation", `brandKit: no kit "${look.brandKit}"`);
  return startJob(runId, "rerender", rerenderArgs(runId, look), 0);
}
