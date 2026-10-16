import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const FPS = 30;

export const Aspect = z.enum(["9:16", "16:9"]);
export type Aspect = z.infer<typeof Aspect>;

export type Size = { width: number; height: number };

export function outputSize(aspect: Aspect): Size {
  return aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

/** Multiples of 16 (the picture models need them); the fit stage crops down to the output size. */
export function keyframeSize(aspect: Aspect): Size {
  return aspect === "9:16" ? { width: 1088, height: 1920 } : { width: 1920, height: 1088 };
}

const Env = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default("gemini-flash-latest"),
  FLOWCHAIN_BUDGET_USD: z.coerce.number().positive().default(3),
  RUNPOD_API_KEY: z.string().min(1).optional(),
  RUNPOD_KEYFRAME_ENDPOINT: z.string().min(1).optional(),
  RUNPOD_CLIP_ENDPOINT: z.string().min(1).optional(),
  /**
   * The hosted voice (phase 5 spec §11): with its key set, every new run is spoken there, and the studio's own
   * voice below is the one used without it. Its model is the one new runs are frozen with.
   */
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  // (eleven_v3: the most expressive, at the same price a character as multilingual v2: phase 5 spec §11.6)
  ELEVENLABS_MODEL: z.string().regex(/^[a-z0-9_]{1,60}$/).default("eleven_v3"),
  /** The studio's own voice (phase 5 spec §6.1): where new runs are spoken without the hosted voice's key. */
  RUNPOD_VOICE_ENDPOINT: z.string().min(1).optional(),
  /** The upscaling worker (phase 8 spec §8): full HD is offered only where it is set. */
  RUNPOD_UPSCALE_ENDPOINT: z.string().min(1).optional(),
  /** Which of the voice worker's voices new runs use. */
  FLOWCHAIN_VOICE: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).default("narrator-m"),
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
  // The first three price hosted models the studio no longer buys from (phase 5 spec §5.1). They stay because
  // price tables frozen into older runs carry them, and those runs' recorded estimates are computed from them.
  fluxPerMegapixel: z.number().default(0.025),
  klingBase5s: z.number().default(0.25),
  klingPerExtraSec: z.number().default(0.05),
  // The hosted voice (phase 5 spec §11), by the character. 0.30 is the dearest it is sold at (the smallest plan's
  // characters beyond what it includes): what a line is expected to cost, and what it is charged, is never less
  // than it was. Lower it when the plan bought says so.
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
  // The studio's own voice (5). Optional with no schema default, for the same reason as the fields above.
  runpodVoiceUsdPerSec: z.number().optional(),
  runpodVoiceSecPerLine: z.number().optional(),
  runpodVoiceSecPerChar: z.number().optional(),
  runpodVoiceColdStartSec: z.number().optional(),
  runpodPictureSec: z.number().optional(),
  runpodPortraitSec: z.number().optional(),
  runpodPictureColdStartSec: z.number().optional(),
  runpodClip720SecPerFrame: z.number().optional(),
  runpodUpscaleUsdPerSec: z.number().optional(),
  runpodUpscaleSecPerClipSec: z.number().optional(),
  runpodUpscaleColdStartSec: z.number().optional(),
});
export type Prices = z.infer<typeof Prices>;

export type RunpodRates = ReturnType<typeof runpodRates>;

/** RunPod rates with their defaults (2.4 spec §6): GPU $/s per endpoint and the estimated seconds per job. */
export function runpodRates(p: Prices) {
  return {
    keyframeUsdPerSec: p.runpodKeyframeUsdPerSec ?? 0.000306, // RTX 4090
    clipUsdPerSec: p.runpodClipUsdPerSec ?? 0.000306, // RTX 4090 (no 48 GB card was in stock in the volume's data centre)
    keyframeSec: p.runpodKeyframeSec ?? 8,
    referenceSec: p.runpodReferenceSec ?? 8,
    // What a clip is expected to cost before it is made (what it did cost is measured, job by job, and that is
    // what a run is charged). 14 clips made on a warm worker in four runs on 2026-10-10 took 0.80 to 0.99 s a
    // frame (49 to 64 s for 53 to 73 frames); 1.5 had been assumed, which priced a run's clips, and so the most
    // its owner is asked to approve, half as high again as they came to. 1.0 is above every one measured: an
    // estimate that is too low stops a run at its cap, so it is kept on the safe side of the measurements.
    clipSecPerFrame: p.runpodClipSecPerFrame ?? 1.0,
    coldStartSec: p.runpodColdStartSec ?? 90,
    // Measured on the live endpoint (phase 5 spec §9.6): a line of about 85 characters took 4.6 s of GPU, and
    // the first line of a run another 40 s for the worker to load its models.
    voiceUsdPerSec: p.runpodVoiceUsdPerSec ?? 0.000306,
    voiceSecPerLine: p.runpodVoiceSecPerLine ?? 3,
    voiceSecPerChar: p.runpodVoiceSecPerChar ?? 0.02,
    voiceColdStartSec: p.runpodVoiceColdStartSec ?? 40,
    // The klein picture worker (phase 5 spec §9.9–9.10): 4.5 s a picture with a portrait, 1.3 s the portrait,
    // each with the upload and the job's own overhead; 60 s for a stopped worker to load the model.
    pictureSec: p.runpodPictureSec ?? 6,
    portraitSec: p.runpodPortraitSec ?? 3,
    pictureColdStartSec: p.runpodPictureColdStartSec ?? 60,
    // 720p clips on the same card: 157 s for 65 frames (§9.9)
    clip720SecPerFrame: p.runpodClip720SecPerFrame ?? 2.5,
    // full HD (phase 8 spec §8): SeedVR2 took 35-40 GPU seconds for each second of a 480p clip on an A100, warm
    // (the trial of 2026-10-16); the endpoint's own card and rate replace these once it is measured there
    upscaleUsdPerSec: p.runpodUpscaleUsdPerSec ?? 0.000306,
    upscaleSecPerClipSec: p.runpodUpscaleSecPerClipSec ?? 40,
    upscaleColdStartSec: p.runpodUpscaleColdStartSec ?? 90,
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
