import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const FPS = 30;
/** The frame rate a run is fitted and rendered at: the pipeline's 30, or the 60 the run was made for (phase 11 spec §2). */
export const fpsOf = (request: { fps?: 60 }): number => request.fps ?? FPS;

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
  /** The FLUX 3 klein picture worker (phase 10 spec §3): new runs use it only while this and its prices are set. */
  RUNPOD_PICTURE3_ENDPOINT: z.string().min(1).optional(),
  /** `klein4b` forces the 4B picture worker (the fallback); `flux3` insists on the new one and refuses to start a run without it. */
  FLOWCHAIN_IMAGE_MODEL: z.enum(["flux3", "klein4b"]).optional(),
  /** Reframe cuts and the shared look reference (phase 10 spec §5): off until the owner's comparison says on. Frozen per run. */
  FLOWCHAIN_CUT_REFERENCES: z.enum(["on", "off"]).default("off"),
  FLOWCHAIN_SMOOTH_MOTION: z.enum(["on", "off"]).default("off"),
  /**
   * Scene sound (phase 14 spec §3): a new run is made with a sound for each scene only while this is on, the Foley
   * endpoint is set and its three prices are in prices.json. Frozen per run (`request.sceneSound`); off = rollback.
   */
  FLOWCHAIN_SCENE_SOUND: z.enum(["on", "off"]).default("off"),
  /** The Foley worker (phase 14 spec §4): makes a scene's sound from its picture. */
  RUNPOD_FOLEY_ENDPOINT: z.string().min(1).optional(),
  /** Topic ideas from the web and the public chart (phase 13): the studio offers them only while this is on. */
  FLOWCHAIN_TREND_IDEAS: z.enum(["on", "off"]).default("off"),
  /** The public chart's key: without it the ideas call uses the web alone. */
  YOUTUBE_API_KEY: z.string().min(1).optional(),
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
  // Smooth motion (phase 11 spec §4): no default on purpose. A 60 fps run is refused until the owner has measured these
  // on the restorer endpoint and set all four, so a customer is never charged from a guess.
  runpodInterpolateUsdPerSec: z.number().positive().optional(),
  runpodInterpolateSecPerClipSec: z.number().positive().optional(),
  runpodInterpolateColdStartSec: z.number().positive().optional(),
  runpodRestoreExtraSecPerClipSec: z.number().positive().optional(),
  // FLUX 3 klein (phase 10 spec §3): no default on purpose. The profile is not offered until the owner has measured
  // these on the real endpoint and set all four, so a customer is never charged from a guess.
  runpodPicture3UsdPerSec: z.number().positive().optional(),
  runpodPicture3Sec: z.number().positive().optional(),
  runpodPortrait3Sec: z.number().positive().optional(),
  runpodPicture3ColdStartSec: z.number().positive().optional(),
  // Scene sound (phase 14 spec §3): no default on purpose, as above. A run is made without scene sound until the owner
  // has measured these on the Foley endpoint and set all three; keep them while any run made with it may be resumed.
  runpodFoleyUsdPerSec: z.number().positive().optional(),
  runpodFoleySecPerClipSec: z.number().positive().optional(),
  runpodFoleyColdStartSec: z.number().positive().optional(),
});
export type Prices = z.infer<typeof Prices>;

export type RunpodRates = ReturnType<typeof runpodRates>;

export type Flux3Rates = { usdPerSec: number; pictureSec: number; portraitSec: number; coldStartSec: number };

/** The FLUX 3 picture worker's rates, or null while any of the four is not set. */
export function flux3Rates(p: Prices): Flux3Rates | null {
  const { runpodPicture3UsdPerSec: usdPerSec, runpodPicture3Sec: pictureSec, runpodPortrait3Sec: portraitSec, runpodPicture3ColdStartSec: coldStartSec } = p;
  return usdPerSec === undefined || pictureSec === undefined || portraitSec === undefined || coldStartSec === undefined ? null : { usdPerSec, pictureSec, portraitSec, coldStartSec };
}

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
    // full HD (phase 8 spec §8.2): measured on the endpoint's own 24 GB card on 2026-10-16, 107-108 GPU seconds for
    // each second of a 480p clip in batches of 21 and tiles (the A100 of the trial took 40, in batches of 33). The
    // first clip of a run cost no more than the others: what a start costs is not in the billed time
    upscaleUsdPerSec: p.runpodUpscaleUsdPerSec ?? 0.000306,
    upscaleSecPerClipSec: p.runpodUpscaleSecPerClipSec ?? 110,
    upscaleColdStartSec: p.runpodUpscaleColdStartSec ?? 20,
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

export type RestoreRates = { usdPerSec: number; interpolateSecPerClipSec: number; coldStartSec: number; extraSecPerClipSec: number };

/** The restorer's smooth-motion rates, or null while any of the four is not set. */
export function restoreRates(p: Prices): RestoreRates | null {
  const { runpodInterpolateUsdPerSec: usdPerSec, runpodInterpolateSecPerClipSec: interpolateSecPerClipSec, runpodInterpolateColdStartSec: coldStartSec, runpodRestoreExtraSecPerClipSec: extraSecPerClipSec } = p;
  return usdPerSec === undefined || interpolateSecPerClipSec === undefined || coldStartSec === undefined || extraSecPerClipSec === undefined
    ? null
    : { usdPerSec, interpolateSecPerClipSec, coldStartSec, extraSecPerClipSec };
}

/** The plain refusal every part of the pipeline gives while the rates are missing (one text, so it is one message to the owner). */
export const RESTORE_RATES_MISSING =
  "smooth motion is not set up: the four rates runpodInterpolateUsdPerSec, runpodInterpolateSecPerClipSec, runpodInterpolateColdStartSec and runpodRestoreExtraSecPerClipSec are not all set in prices.json";

export type FoleyRates = { usdPerSec: number; secPerClipSec: number; coldStartSec: number };

/** The Foley worker's rates, or undefined while any of the three is not set. */
export function foleyRates(p: Prices): FoleyRates | undefined {
  const { runpodFoleyUsdPerSec: usdPerSec, runpodFoleySecPerClipSec: secPerClipSec, runpodFoleyColdStartSec: coldStartSec } = p;
  return usdPerSec === undefined || secPerClipSec === undefined || coldStartSec === undefined ? undefined : { usdPerSec, secPerClipSec, coldStartSec };
}

/** The plain refusal every part of the pipeline gives while the Foley rates are missing (one text, one message to the owner). */
export const FOLEY_RATES_MISSING =
  "scene sound is not set up: the three rates runpodFoleyUsdPerSec, runpodFoleySecPerClipSec and runpodFoleyColdStartSec are not all set in prices.json";
