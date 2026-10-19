import type { Prices } from "../config.js";
import { round4 } from "../cost.js";
import type { ImageProfileId } from "../image-profiles.js";
import { TIMEOUTS, withRetry } from "../providers/retry.js";
import type { RunContext } from "./types.js";

/** Only the FLUX 3 profile's model is not to be used without an upsampler (phase 10 spec §2). */
export const needsUpsampling = (id: ImageProfileId | undefined): boolean => id === "runpod-flux3-klein@1";

/** What one expansion costs: the instructions (about 1,500 tokens) and the prompt in, each picture at about 260 tokens, a longer prompt out. */
export function upsampleCost(p: Pick<Prices, "llmPerMInputTokens" | "llmPerMOutputTokens">, promptChars: number, images: number): number {
  return round4((((promptChars / 4) + 1500 + images * 260) * p.llmPerMInputTokens + 500 * p.llmPerMOutputTokens) / 1e6);
}

/**
 * Expands a picture prompt, and charges for it. A provider without `upsample` (the test stand-ins) leaves the
 * prompt as it is. A model that cannot be reached stops the picture: the FLUX 3 model is not to be used without
 * its upsampler, and an unexpanded prompt would spend a picture's GPU seconds on a worse one. The message never
 * carries the provider's own text. The upsampled prompt is not stored (phase 10 spec §6).
 */
export async function upsample(ctx: RunContext, prompt: string, referencePaths: string[] = []): Promise<string> {
  const llm = ctx.providers.llm;
  if (!llm.upsample) return prompt;
  try {
    const expanded = await withRetry("prompt expansion", () => llm.upsample!({ prompt, ...(referencePaths.length ? { images: referencePaths } : {}) }), { timeoutMs: TIMEOUTS.llm, baseDelayMs: ctx.retryDelayMs, attempts: 2 });
    await ctx.charge(upsampleCost(ctx.prices, prompt.length, referencePaths.length));
    return expanded;
  } catch {
    throw new Error("the picture prompt could not be expanded for the picture model; resume the run to try again");
  }
}

/**
 * What a stage's estimate adds for the expansion: deliberately a long prompt (800 characters) and, for a keyframe,
 * the most pictures it is shown (3). The approval and the cap are built from estimates, and an estimate under the
 * real charge would let a picture through that the budget did not see; over-counting by a fraction of a cent is safe.
 */
export const upsampleEstimate = (p: Pick<Prices, "llmPerMInputTokens" | "llmPerMOutputTokens">, images: number): number => upsampleCost(p, 800, images);
