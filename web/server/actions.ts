import { existsSync } from "node:fs";
import { newRunId } from "@src/manifest/store";
import type { PlanJson } from "@src/studio/commands";
import { statusOf } from "@src/studio/status";
import { draftCapUsd, newTenantRun, reserve } from "./credit";
import { ApiError } from "./http";
import { round4 } from "@/lib/credit";
import { cliJson, cliText, jobReady, type JobView, releaseJob, startJob, studioHealthRaw, viewJob } from "./jobs";
import { requireManifest } from "./runs";
import { multiTenant } from "./tenant";
import { nativeVoices, offeredLanguages, readyVoices } from "./voices";
import { versionProblem } from "@src/versions";
import type { SpeechLanguage } from "@src/voice/language";
import { draftArgs, formProblem, kitDir, type Look, modesArg, musicPath, type NewVideo, rerenderArgs } from "./schemas";

/** The run has a job that is running or waiting its turn. */
async function busy(runId: string): Promise<boolean> {
  const state = (await viewJob(runId))?.state;
  return state === "running" || state === "queued";
}

type RerollTarget = { scene: number; stage: string };

/** Buys the script for a new run and stops there. The keys a run needs must be set first. */
/** `seriesId`: the run is one of that series' videos (the caller's own series: the database checks). */
export async function createDraft(input: NewVideo, seriesId?: string): Promise<{ runId: string; job: JobView }> {
  const { missing, queue, fullHd, smooth } = await studioHealthRaw();
  // with the queue the keys are the worker's: when it cannot be asked, nothing is known about them
  if (queue.mode === "queue" && !(queue.redis && queue.worker)) {
    throw new ApiError(queue.redis ? "worker_offline" : "queue_unavailable", queue.redis ? "the worker is offline" : "the job queue is unavailable", "nothing was started; try again in a moment");
  }
  const unset = missing;
  if (unset.length > 0 && multiTenant()) throw new ApiError("missing_keys", "the studio is not ready to make videos yet", "nothing was started; try again later");
  if (unset.length > 0) {
    const where = queue.mode === "queue" ? "set them in .env or deploy/server.env and run npm run server:setup again" : "add them to .env in the repository, then try again";
    throw new ApiError("missing_keys", `${queue.mode === "queue" ? "the worker has no" : "not set in .env:"} ${unset.join(", ")}`, where);
  }
  if (input.brandKit && !existsSync(kitDir(input.brandKit))) throw new ApiError("validation", `brandKit: no kit "${input.brandKit}"`);
  if (input.music && !existsSync(musicPath(input.music))) throw new ApiError("validation", `music: no track ${input.music}`);
  // a voice on the list whose clip has not been made yet has nothing to speak from
  if (input.voiceId && !readyVoices().includes(input.voiceId)) throw new ApiError("validation", `voiceId: the voice ${input.voiceId} is not ready yet`);
  // a language only the hosted voice speaks is not offered without it (phase 7 spec §17)
  if (input.language && !offeredLanguages().includes(input.language)) throw new ApiError("validation", `language: ${input.language} is not offered in this studio`);
  // full HD is offered only where its worker is set up (phase 8 spec §8)
  if (input.clips === "1080p" && !fullHd) throw new ApiError("validation", "clips: full HD is not available in this studio yet");
  // smooth motion is offered only where the restorer is set up and switched on (phase 11 spec §11)
  if (input.fps === 60 && !smooth) throw new ApiError("validation", "fps: smooth motion is not available in this studio yet");
  const problem = formProblem(input);
  if (problem) throw new ApiError("validation", problem);
  if (multiTenant()) {
    // the run is registered as the user's, and the script's cost is held from their credit, before anything is queued
    const runId = await newTenantRun(input.topic, seriesId);
    return { runId, job: await startPaid(runId, "draft", draftArgs(input, runId), draftCapUsd({ targetSec: input.durationSec, sceneSec: input.sceneSec })) };
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
  // a 60 fps draft made while smooth motion was on would buy its clips and then fail at the restorer if the switch has
  // since gone off (a rollback): refuse before anything is priced, held or queued
  if ((await requireManifest(runId)).request.fps === 60 && !(await studioHealthRaw()).smooth) {
    throw new ApiError("validation", "smooth motion is not available in this studio right now");
  }
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

/** A version's language and voice as asked for (phase 8 spec §4.1). */
export type VersionAsk = { language: SpeechLanguage; voiceId?: string };

/** What may stop a version before anything is asked of the CLI: the run, the language, the voice. */
async function checkVersion(sourceId: string, ask: VersionAsk): Promise<string> {
  const source = await requireManifest(sourceId);
  const problem = versionProblem(source, ask.language);
  if (problem) throw new ApiError("validation", problem.replace(/^run \S+ /, "this video ").replace(/ \(--no-localize\)$/, ""));
  if (!offeredLanguages().includes(ask.language)) throw new ApiError("validation", `language: ${ask.language} is not offered in this studio`);
  // the voice it is asked in, or the run's own: one that speaks the new language as its own
  const voice = ask.voiceId ?? source.request.voiceId;
  if (!(nativeVoices()[ask.language] ?? []).includes(voice as never)) throw new ApiError("validation", `voiceId: that voice does not speak ${ask.language}; choose one of the language's own`);
  return voice;
}

export type VersionPrice = PlanJson & { capUsd: number };

/** What a version would cost and what it holds, from the CLI's own planner; nothing is made. */
export async function versionPrice(sourceId: string, ask: VersionAsk): Promise<VersionPrice> {
  const voice = await checkVersion(sourceId, ask);
  return cliJson<VersionPrice>(["plan", sourceId, "--json", "--translate", ask.language, "--voice", voice]);
}

/**
 * Makes a run in another language: a new run, with the source's pictures and clips, and its own narration, voice
 * and captions. What it holds is what its owner was shown, checked again here: a different figure starts nothing.
 */
export async function createVersion(sourceId: string, ask: VersionAsk & { approvedUsd: number }): Promise<{ runId: string; job: JobView }> {
  const voice = await checkVersion(sourceId, ask);
  const price = await cliJson<VersionPrice>(["plan", sourceId, "--json", "--translate", ask.language, "--voice", voice]);
  if (typeof price.capUsd !== "number" || !Number.isFinite(price.capUsd)) throw new ApiError("internal", "the CLI's plan has no total, so nothing was started");
  const approved = round4(ask.approvedUsd);
  if (price.capUsd > approved) {
    throw new ApiError("estimate_changed", "the estimate changed since it was shown", "check the new estimate and confirm again", { totalUsd: price.capUsd });
  }
  const source = await requireManifest(sourceId);
  const runId = multiTenant() ? await newTenantRun(source.request.topic) : newRunId();
  const cap = String(price.capUsd);
  // no --yes: the cap is the most it may spend, and a plan above it stops the CLI instead of spending
  const args = ["translate", sourceId, "--language", ask.language, "--voice", voice, "--run-id", runId, "--budget", cap, "--cap", cap];
  return { runId, job: await startPaid(runId, "generate", args, price.capUsd) };
}
