import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import type { Prices } from "../config.js";
import { round4 } from "../cost.js";
import type { StageName } from "../manifest/schema.js";
import { saveManifest } from "../manifest/store.js";
import { countFrames } from "../media/ffmpeg.js";
import { extractFrame } from "../media/frames.js";
import { withRetry, TIMEOUTS } from "../providers/retry.js";
import type { RunContext } from "./types.js";

/*
 * A look at every picture and clip before money is spent on what follows from it (phase 8 spec §9). A falcon's
 * picture came out with two heads, its clip grew a third wing, and the clip and its full HD upscale were bought on
 * top of it. The script's model looks at each one for the faults a viewer sees at a glance; one that has them is
 * made again with a new seed, a picture twice at most and a clip once.
 */

export const Verdict = z.object({ ok: z.boolean(), problems: z.array(z.string()).default([]) });
export type Verdict = z.infer<typeof Verdict>;

/** How many times each is made again at most: a picture costs a fifth of a cent, a clip a few cents. */
export const MAX_REMAKES: Partial<Record<StageName, number>> = { keyframes: 2, clips: 1 };

/** What one look costs: a picture is about 260 tokens to the model, the question and the answer a few hundred. */
export function inspectCost(p: Prices, images: number): number {
  return round4(((images * 260 + 450) * p.llmPerMInputTokens + 80 * p.llmPerMOutputTokens) / 1e6);
}

/**
 * Looks, and charges for it. A look that cannot be had (the model is away, the answer is not one) passes the picture:
 * a checker that is down is no reason to stop a paid run.
 */
export async function inspect(ctx: RunContext, images: string[], expected: string): Promise<Verdict> {
  const llm = ctx.providers.llm;
  if (!llm.inspect) return { ok: true, problems: [] };
  try {
    const raw = await withRetry("picture check", () => llm.inspect!({ images, expected }), { timeoutMs: TIMEOUTS.llm, baseDelayMs: ctx.retryDelayMs, attempts: 2 });
    await ctx.charge(inspectCost(ctx.prices, images.length));
    const verdict = Verdict.safeParse(raw);
    return verdict.success ? verdict.data : { ok: true, problems: [] };
  } catch (err) {
    ctx.log(`the picture check could not be done (${err instanceof Error ? err.message : String(err)}); the picture is used as it is`);
    return { ok: true, problems: [] };
  }
}

/** Three frames of a clip, from its start, middle and end, written beside it for a look and removed after. */
export async function clipFrames(video: string, dir: string): Promise<{ files: string[]; done: () => Promise<void> }> {
  const frames = Math.max(1, await countFrames(video));
  const at = [0.15, 0.55, 0.95].map((f) => Math.min(frames - 1, Math.round(frames * f)));
  await mkdir(dir, { recursive: true });
  const files = at.map((n) => join(dir, `look_${n}.png`));
  await Promise.all(at.map((n, k) => extractFrame(video, n, files[k])));
  return { files, done: () => rm(dir, { recursive: true, force: true }) };
}

/** Which remake a scene's stage is at, for the inputs it is being made for now (0 = the first). */
export function remakeOf(ctx: RunContext, scene: number, stage: StageName): number {
  const r = ctx.manifest.scenes[scene].remade?.[stage];
  return r && r.inputHash === ctx.inputHash ? r.count : 0;
}

/** Records that a scene's stage is to be made again, before the new one is bought. */
export async function noteRemake(ctx: RunContext, scene: number, stage: StageName, count: number): Promise<void> {
  const s = ctx.manifest.scenes[scene];
  s.remade = { ...s.remade, [stage]: { inputHash: ctx.inputHash, count } };
  await saveManifest(ctx.dir, ctx.manifest);
}
