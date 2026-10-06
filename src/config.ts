import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const FPS = 30;

export const Aspect = z.enum(["9:16", "16:9"]);
export type Aspect = z.infer<typeof Aspect>;

export type Size = { width: number; height: number };

export function outputSize(aspect: Aspect): Size {
  return aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

/** Flux needs multiples of 16; the fit stage crops down to the output size. */
export function keyframeSize(aspect: Aspect): Size {
  return aspect === "9:16" ? { width: 1088, height: 1920 } : { width: 1920, height: 1088 };
}

const Env = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default("gemini-flash-latest"),
  /** fal provider (runs with unprefixed model ids). */
  FAL_KEY: z.string().min(1).optional(),
  FAL_IMAGE_MODEL: z.string().min(1).default("fal-ai/flux/dev"),
  FAL_VIDEO_MODEL: z.string().min(1).default("fal-ai/kling-video/v2.1/standard/image-to-video"),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  ELEVENLABS_MODEL: z.string().min(1).default("eleven_multilingual_v2"),
  FLOWCHAIN_BUDGET_USD: z.coerce.number().positive().default(3),
  /** The image/video provider for new runs; each run keeps its own (2.4 spec §3.4). */
  PROVIDER_MODE: z.enum(["fal", "runpod"]).default("fal"),
  RUNPOD_API_KEY: z.string().min(1).optional(),
  RUNPOD_KEYFRAME_ENDPOINT: z.string().min(1).optional(),
  RUNPOD_CLIP_ENDPOINT: z.string().min(1).optional(),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  RUNS_DIR: z.string().min(1).default("./runs"),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment (copy .env.example to .env and fill it in):\n${problems}`);
  }
  return result.data;
}

export const Prices = z.strictObject({
  fluxPerMegapixel: z.number().default(0.025),
  klingBase5s: z.number().default(0.25),
  klingPerExtraSec: z.number().default(0.05),
  ttsPer1kChars: z.number().default(0.3),
  llmPerMInputTokens: z.number().default(0.3),
  llmPerMOutputTokens: z.number().default(2.5),
  // RunPod (2.4). Optional with no schema default: price tables frozen into runs made before 2.4 then hash
  // exactly as before (undefined is dropped); `runpodRates` fills the defaults where they are used.
  runpodKeyframeUsdPerSec: z.number().optional(),
  runpodClipUsdPerSec: z.number().optional(),
  runpodKeyframeSec: z.number().optional(),
  runpodReferenceSec: z.number().optional(),
  runpodClipSecPerFrame: z.number().optional(),
  runpodColdStartSec: z.number().optional(),
});
export type Prices = z.infer<typeof Prices>;

export type RunpodRates = ReturnType<typeof runpodRates>;

/** RunPod rates with their defaults (2.4 spec §6): GPU $/s per endpoint and the estimated seconds per job. */
export function runpodRates(p: Prices) {
  return {
    keyframeUsdPerSec: p.runpodKeyframeUsdPerSec ?? 0.000306, // RTX 4090
    clipUsdPerSec: p.runpodClipUsdPerSec ?? 0.000486, // L40S
    keyframeSec: p.runpodKeyframeSec ?? 8,
    referenceSec: p.runpodReferenceSec ?? 8,
    clipSecPerFrame: p.runpodClipSecPerFrame ?? 1.5,
    coldStartSec: p.runpodColdStartSec ?? 90,
  };
}

export function loadPrices(path = "prices.json"): Prices {
  if (!existsSync(path)) return Prices.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const result = Prices.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid price table in ${path}:\n${problems}`);
  }
  return result.data;
}
