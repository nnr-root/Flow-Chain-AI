import type { ProviderJob, StageName } from "../manifest/schema.js";
import { saveManifest } from "../manifest/store.js";
import { TIMEOUTS, UnusableResultError, withRetry } from "../providers/retry.js";
import type { RunContext } from "./types.js";

export type JobSpec<Out extends { url: string; seed?: number }> = {
  /** Human label for logs and errors, e.g. "clip scene 2". */
  label: string;
  /** What one completed job costs (charged exactly once per job). */
  costUsd: number;
  /** Buys one job and returns its request id. Called at most once per inputHash. */
  submit: () => Promise<string>;
  /** Polls a submitted request until it completes. Safe to repeat. */
  wait: (requestId: string) => Promise<Out>;
  /** How long one wait may take (the provider enforces it). */
  waitMs: number;
};

/** Extra time for the outer race in withRetry, so the provider's own deadline normally fires first. */
const WAIT_SLACK_MS = 30_000;

async function chargeOnce(ctx: RunContext, job: ProviderJob, usd: number): Promise<void> {
  if (job.chargedUsd > 0) {
    await saveManifest(ctx.dir, ctx.manifest);
    return;
  }
  job.chargedUsd = usd;
  await ctx.charge(usd); // also saves the manifest, including the job record
}

/**
 * Runs one paid queued provider job for (scene, stage) at ctx.inputHash, and never pays twice for it:
 * - a completed, charged result for this inputHash is reused (only post-processing is repeated);
 * - a pending request id for this inputHash is polled again instead of resubmitting;
 * - otherwise exactly one job is submitted and its id saved to the manifest BEFORE waiting.
 * A timeout or error while waiting fails the stage with the request id kept. Spend is recorded the moment
 * the job completes, before any download. A new inputHash (e.g. a reroll nonce bump) submits a new job.
 */
export async function runProviderJob<Out extends { url: string; seed?: number }>(
  ctx: RunContext,
  scene: number,
  stage: StageName,
  spec: JobSpec<Out>,
): Promise<Out> {
  const state = ctx.manifest.scenes[scene];
  let job = state.jobs[stage];
  if (job && job.inputHash !== ctx.inputHash) job = undefined;
  if (job?.result) {
    ctx.log(`${spec.label}: reusing the paid result of fal request ${job.requestId}`);
    return job.result as Out;
  }

  if (!job) {
    // Submitted once, never retried: a lost response to a retried submit could buy the same job twice.
    const requestId = await withRetry(`${spec.label} (submit)`, spec.submit, {
      attempts: 1,
      timeoutMs: TIMEOUTS.submit,
    });
    job = { requestId, inputHash: ctx.inputHash, submittedAt: new Date().toISOString(), chargedUsd: 0 };
    state.jobs[stage] = job;
    await saveManifest(ctx.dir, ctx.manifest);
    ctx.log(`${spec.label}: submitted fal request ${requestId}`);
  } else {
    ctx.log(`${spec.label}: resuming fal request ${job.requestId}`);
  }

  const pending = job;
  let result: Out;
  try {
    result = await withRetry(spec.label, () => spec.wait(pending.requestId), {
      timeoutMs: spec.waitMs + WAIT_SLACK_MS,
      baseDelayMs: ctx.retryDelayMs,
    });
  } catch (err) {
    // The job completed, so it was billed, even though its output is unusable.
    if (err instanceof Error && err.cause instanceof UnusableResultError) await chargeOnce(ctx, pending, spec.costUsd);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message} [fal request ${pending.requestId} is kept: resume polls it again instead of paying for a new one; ` +
        `reroll this scene's ${stage} to submit a new request]`,
      { cause: err },
    );
  }
  pending.result = result.seed === undefined ? { url: result.url } : { url: result.url, seed: result.seed };
  await chargeOnce(ctx, pending, spec.costUsd);
  return result;
}
