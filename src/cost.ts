import type { Prices, Size } from "./config.js";

/** Token assumptions for one script call (Gemini usage is not metered per call in Phase 1). */
export const SCRIPT_TOKENS = { input: 1500, output: 2000 };

/** Used by the first checkpoint, before the script exists. */
export const FALLBACK_NARRATION_CHARS = 130;

export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export function scriptCost(p: Prices): number {
  return round4((SCRIPT_TOKENS.input * p.llmPerMInputTokens + SCRIPT_TOKENS.output * p.llmPerMOutputTokens) / 1e6);
}

export function ttsCost(p: Prices, chars: number): number {
  return round4((chars / 1000) * p.ttsPer1kChars);
}

export function imageCost(p: Prices, size: Size): number {
  return round4((p.fluxPerMegapixel * size.width * size.height) / 1e6);
}

export function videoCost(p: Prices, seconds: number): number {
  return round4(p.klingBase5s + Math.max(0, seconds - 5) * p.klingPerExtraSec);
}
