import { stat } from "node:fs/promises";
import type { ProviderJob, StageName } from "../manifest/schema.js";
import { download, DownloadError } from "../providers/download.js";
import { saveManifest } from "../manifest/store.js";
import { TIMEOUTS, UnusableResultError, withRetry } from "../providers/retry.js";
import type { PreparedJob } from "../providers/types.js";
import type { RunContext } from "./types.js";

export type JobSpec<Out extends { url: string; seed?: number; costUsd?: number }> = {
  /** Human label for logs and errors, e.g. "clip scene 2". */
  label: string;
  /** What one completed job costs (charged exactly once per job). */
  costUsd: number;
  /** Free work before buying (seam render, input upload). Safe to repeat; runs before the submit deadline. */
  prepare: () => Promise<PreparedJob>;
  /** Buys one job and returns its request id. Must stop (reject) when `signal` aborts. */
  submit: (job: PreparedJob, signal: AbortSignal) => Promise<string>;
  /** Deadline for the submit request alone (default TIMEOUTS.submit). */
  submitTimeoutMs?: number;
  /** Polls a submitted request until it completes. Safe to repeat. */
  wait: (requestId: string) => Promise<Out>;
  /** How long one wait may take (the provider enforces it). */
  waitMs: number;
};

/** Extra time for the outer race in withRetry, so the provider's own deadline normally fires first. */
const WAIT_SLACK_MS = 30_000;

/**
 * What an LTX clip's answer carries beyond its url (phase 15): kept with the result, as the provider gave it, so a stop
 * after the job is charged loses none of it. Only the keys a result has: every other kind of result is kept as it was.
 */
function heard(result: object): Pick<NonNullable<ProviderJob["result"]>, "fps" | "hasAudio" | "words"> {
  const r = result as Pick<NonNullable<ProviderJob["result"]>, "fps" | "hasAudio" | "words">;
  return { ...(r.fps === undefined ? {} : { fps: r.fps }), ...(r.hasAudio === undefined ? {} : { hasAudio: r.hasAudio }), ...(r.words === undefined ? {} : { words: r.words }) };
}

/**
 * Submits exactly once with a real deadline: when it runs out the request is aborted (cancelled), never
 * left running in the background where it could still complete and buy a job nobody records.
 */
async function submitWithDeadline(label: string, submit: () => Promise<string>, controller: AbortController, ms: number) {
  const timer = setTimeout(() => controller.abort(new Error(`${label}: submit timed out after ${ms} ms`)), ms);
  try {
    return await submit();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label}: submit timed out after ${ms} ms and was cancelled; nothing was recorded as bought`, {
        cause: err,
      });
    }
    throw new Error(`${label}: submit failed (not retried, nothing recorded as bought): ${(err as Error).message}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function chargeOnce(ctx: RunContext, job: ProviderJob, usd: number): Promise<void> {
  if (job.chargedUsd > 0) {
    await saveManifest(ctx.dir, ctx.manifest);
    return;
  }
  job.chargedUsd = usd;
  await ctx.charge(usd); // a positive charge also saves the manifest, including the job record
  if (!(usd > 0)) await saveManifest(ctx.dir, ctx.manifest); // a zero charge returns before saving
}

/**
 * Runs one paid queued provider job for (scene, stage) at ctx.inputHash, and never pays twice for it:
 * - a completed, charged result for this inputHash is reused (only post-processing is repeated);
 * - a pending request id for this inputHash is polled again instead of resubmitting;
 * - otherwise the free preparation runs first (retried, off the submit clock), then exactly one job is
 *   submitted under a cancelling deadline, and its id is saved to the manifest BEFORE waiting.
 * A timeout or error while waiting fails the stage with the request id kept. Spend is recorded the moment
 * the job completes, before any download. A new inputHash (e.g. a reroll nonce bump) submits a new job.
 */
export async function runProviderJob<Out extends { url: string; seed?: number; costUsd?: number }>(
  ctx: RunContext,
  scene: number,
  stage: StageName,
  spec: JobSpec<Out>,
): Promise<Out> {
  const state = ctx.manifest.scenes[scene];
  let job = state.jobs[stage];
  if (job && job.inputHash !== ctx.inputHash) job = undefined;
  if (job?.result) {
    ctx.log(`${spec.label}: reusing the paid result of request ${job.requestId}`);
    reused.add(job.result);
    return job.result as Out;
  }

  if (!job) {
    const prepared = await withRetry(`${spec.label} (prepare)`, spec.prepare, {
      timeoutMs: TIMEOUTS.prepare,
      baseDelayMs: ctx.retryDelayMs,
    });
    // Submitted once, never retried: a lost response to a retried submit could buy the same job twice.
    const controller = new AbortController();
    const requestId = await submitWithDeadline(
      spec.label,
      () => spec.submit(prepared, controller.signal),
      controller,
      spec.submitTimeoutMs ?? TIMEOUTS.submit,
    );
    // A job that was submitted for other inputs and never collected is replaced here. The provider bills it all
    // the same, so its cost moves to the scene's `abandonedUsd` in the same save that drops its record.
    const given = state.jobs[stage];
    if (given && !given.result && !(given.chargedUsd > 0) && given.expectedUsd !== undefined && given.expectedUsd > 0) {
      state.abandonedUsd = Math.round(((state.abandonedUsd ?? 0) + given.expectedUsd) * 10_000) / 10_000;
    }
    job = { requestId, inputHash: ctx.inputHash, submittedAt: new Date().toISOString(), expectedUsd: spec.costUsd, chargedUsd: 0 };
    state.jobs[stage] = job;
    await saveManifest(ctx.dir, ctx.manifest);
    ctx.log(`${spec.label}: submitted request ${requestId}`);
  } else {
    ctx.log(`${spec.label}: resuming request ${job.requestId}`);
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
    if (err instanceof Error && err.cause instanceof UnusableResultError) {
      // it is over: what it cost is what is charged now (possibly nothing), no longer what was expected
      delete pending.expectedUsd;
      await chargeOnce(ctx, pending, err.cause.costUsd ?? spec.costUsd);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message} [request ${pending.requestId} is kept: resume polls it again instead of paying for a new one; ` +
        `reroll this scene's ${stage} to submit a new request]`,
      { cause: err },
    );
  }
  pending.result = { url: result.url, ...(result.seed === undefined ? {} : { seed: result.seed }), ...heard(result) };
  // providers that bill by measured GPU time report the actual cost; otherwise the estimate is charged
  await chargeOnce(ctx, pending, result.costUsd ?? spec.costUsd);
  return result;
}

/** Kept results handed back by `runProviderJob` in this process: only their download may fall back to the file on disk. */
const reused = new WeakSet<object>();

/** What a stage's file is called in a message to the customer. */
const NOUN: Partial<Record<StageName, string>> = { clips: "clip", keyframes: "picture", reference: "portrait", upscale: "full HD clip", interpolate: "smooth clip", sound: "sound" };

async function sizeOf(path: string): Promise<number | undefined> {
  return stat(path).then((s) => s.size).catch(() => undefined);
}

/**
 * Brings a finished job's file into the run (`dest`), once: the provider's copy is taken away after it (`remove`), so a
 * kept result reused later (a stop, a failed step after the download) must take the run's own copy, never download again
 * from a url that answers 404. The copy's size is written into the job's result before the caller removes the provider's.
 * A kept result whose copy is missing or changed is downloaded again if it still can be; if not, the scene fails with
 * what to do. `fallback`: for a result kept before sizes were written (none on record), whether the file already at
 * `dest` is this job's; asked only for a reused result whose url answers 404 or 403, never for a job just finished.
 */
export async function collect(ctx: RunContext, scene: number, stage: StageName, result: { url: string }, dest: string, fallback?: () => Promise<boolean>): Promise<void> {
  const kept = ctx.manifest.scenes[scene].jobs[stage]?.result;
  const record = kept?.url === result.url ? kept : undefined;
  const saved = record?.savedBytes;
  if (saved !== undefined && (await sizeOf(dest)) === saved) {
    ctx.log(`scene ${scene + 1}: its ${NOUN[stage] ?? stage} is already here; nothing is downloaded`);
    return;
  }
  try {
    await download(result.url, dest);
  } catch (err) {
    const noun = NOUN[stage] ?? stage;
    // (only an answer that nothing is there means the copy is gone; a timeout or a server error is said as it is)
    const gone = err instanceof DownloadError && (err.status === 404 || err.status === 403);
    if (saved !== undefined && gone) throw new Error(`scene ${scene + 1}: this scene's ${noun} file is gone; make the scene's ${noun} again`, { cause: err });
    if (gone && fallback && reused.has(result) && (await fallback())) {
      ctx.log(`scene ${scene + 1}: its ${noun} is no longer where it was made; the copy already in the run is used`);
    } else throw err;
  }
  const size = await sizeOf(dest);
  if (record && size) {
    record.savedBytes = size;
    await saveManifest(ctx.dir, ctx.manifest);
  }
}
