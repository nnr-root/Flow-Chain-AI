import { runpodRates } from "../config.js";
import { saveManifest } from "../manifest/store.js";
import type { RunContext } from "./types.js";

/** The warm-up's entry in the manifest's `inFlight`: what it is expected to cost, from before it is asked for. */
export const WARMUP_KEY = "clips:warmup";
const SUBMIT_MS = 30_000;
const SETTLE_MS = 5 * 60_000;

const round4 = (usd: number): number => Math.round(usd * 10_000) / 10_000;

function drop(ctx: RunContext): number {
  const m = ctx.manifest;
  const { [WARMUP_KEY]: expected, ...rest } = m.inFlight ?? {};
  m.inFlight = Object.keys(rest).length > 0 ? rest : undefined;
  return expected ?? 0;
}

/**
 * Called before each picture is bought: starts the clip worker once the pictures still to make will take no
 * longer than that worker needs to start, so it is up when the first clip is asked for and has not been up for
 * long (a worker stops, and is billed until it does, 30 s after its last job).
 *
 * `picturesLeft`: this picture and the ones after it. `firstPicture`: the picture worker may have to start too.
 * The estimate errs towards a warm-up that ends after the pictures: the first clip then waits behind it on the
 * same worker, which costs nothing. Never fails the picture: a start that could not be asked for is only a
 * slower first clip.
 */
export async function warmClipsEarly(ctx: RunContext, picturesLeft: number, firstPicture: boolean): Promise<void> {
  const m = ctx.manifest;
  const video = ctx.providers.video;
  if (!video.warm || !video.warmCost || m.warmup) return;
  if (!m.scenes.some((s) => s.mode === 1 && !s.clip)) return; // no clip left to make
  const rates = runpodRates(ctx.prices);
  const picturesSec = picturesLeft * rates.pictureSec + (firstPicture ? rates.pictureColdStartSec : 0);
  if (picturesSec > rates.coldStartSec) return;

  // an entry without a request is from a process that ended while asking: billed or not, nobody will know
  const left = drop(ctx);
  if (left > 0) m.abandonedUsd = round4((m.abandonedUsd ?? 0) + left);
  // on record before it is bought (the rule of src/stages/inflight.ts)
  m.inFlight = { ...m.inFlight, [WARMUP_KEY]: round4(rates.coldStartSec * rates.clipUsdPerSec) };
  await saveManifest(ctx.dir, m);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBMIT_MS);
  try {
    const requestId = await video.warm({ signal: controller.signal });
    m.warmup = { requestId, submittedAt: new Date().toISOString() };
    ctx.log(`clip worker: early start asked for (request ${requestId})`);
  } catch {
    drop(ctx); // refused or cancelled: nothing was bought
    ctx.log("clip worker: the early start could not be asked for; the first clip will wait for the worker instead");
  } finally {
    clearTimeout(timer);
  }
  await saveManifest(ctx.dir, m);
}

/**
 * Called before a clip is bought: charges what the early start cost and takes it off the in-flight record, in one
 * save. The clip would wait behind the warm-up on the worker anyway, so waiting for it here loses no time. A
 * start whose cost cannot be learnt is kept at what was expected (`abandonedUsd`), never dropped.
 */
export async function settleWarmup(ctx: RunContext): Promise<void> {
  const m = ctx.manifest;
  const warmup = m.warmup;
  if (!warmup) return;
  let cost: number | undefined;
  try {
    cost = await ctx.providers.video.warmCost?.(warmup.requestId, { timeoutMs: SETTLE_MS });
  } catch {
    cost = undefined;
  }
  delete m.warmup;
  const expected = drop(ctx);
  if (cost === undefined) m.abandonedUsd = round4((m.abandonedUsd ?? 0) + expected);
  if (cost !== undefined && cost > 0) await ctx.charge(cost); // saves the ledger entry and the removals together
  else await saveManifest(ctx.dir, m);
}
