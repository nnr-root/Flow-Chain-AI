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
  /** Wan's clip worker, removed on 2026-11-02 (phase 15 spec §13.10): still accepted, so an older `.env` loads, and read by nothing. */
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
   * Scene sound bought from the Foley worker (phase 14), removed on 2026-11-02 (phase 15 spec §13.12): both are still
   * accepted, so an older `.env` loads, and read by nothing. A scene's sound is its own clip's now.
   */
  FLOWCHAIN_SCENE_SOUND: z.enum(["on", "off"]).default("off"),
  RUNPOD_FOLEY_ENDPOINT: z.string().min(1).optional(),
  /** The LTX worker (phase 15): makes a clip, with its sound and the words of its speech, on the studio's own endpoint. */
  RUNPOD_LTX_ENDPOINT: z.string().min(1).optional(),
  /**
   * The owner's switch for LTX clips (phase 15 spec §13.8): new runs are made on LTX only while this is `on`, its endpoint
   * is set and its three rates are in prices.json. `runpod:deploy` writes the endpoint and `server:setup` hands this
   * machine's settings to the server's worker, so without a switch of its own a routine setup after measuring the rates
   * would move paying customers onto LTX before the licence is answered. Unset or `off`: no moving clips (Wan, which made
   * them before, was removed on 2026-11-02, §13.10), so only a run made of pictures can be started. It decides
   * new runs only: a run already made on LTX resumes with its rates whatever it says. Any other word makes `loadEnv` throw.
   */
  FLOWCHAIN_LTX: z.enum(["on", "off"]).optional(),
  /**
   * `on` lets a scene speak in its own clip (phase 15), where LTX makes the clips; unset or `off` leaves speech off, and
   * any other word makes `loadEnv` throw.
   */
  FLOWCHAIN_SPEECH: z.enum(["on", "off"]).optional(),
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
  // Wan's seconds a frame, at 480p and (below) 720p: read by nothing since Wan was removed (phase 15 spec §13.10), kept
  // so an older prices.json, and the price tables frozen into older runs, still load
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
  // The Foley worker's rates (phase 14): read by nothing since it was removed (phase 15 spec §13.12), kept so an older
  // prices.json, and the price tables frozen into older runs, still load
  runpodFoleyUsdPerSec: z.number().positive().optional(),
  runpodFoleySecPerClipSec: z.number().positive().optional(),
  runpodFoleyColdStartSec: z.number().positive().optional(),
  // LTX clips (phase 15): no default on purpose, as above. LTX is not offered until the owner has measured these on the
  // LTX endpoint and set all three; keep them while any run made with it may be resumed or remade.
  runpodLtxUsdPerSec: z.number().positive().optional(),
  runpodLtxSecPerClipSec: z.number().positive().optional(),
  runpodLtxColdStartSec: z.number().positive().optional(),
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

export type LtxRates = { usdPerSec: number; secPerClipSec: number; coldStartSec: number };

/** The LTX worker's rates, or undefined while any of the three is not set (a zero or negative one never gets this far: `Prices` refuses it). */
export function ltxRates(p: Prices): LtxRates | undefined {
  const { runpodLtxUsdPerSec: usdPerSec, runpodLtxSecPerClipSec: secPerClipSec, runpodLtxColdStartSec: coldStartSec } = p;
  return usdPerSec === undefined || secPerClipSec === undefined || coldStartSec === undefined ? undefined : { usdPerSec, secPerClipSec, coldStartSec };
}

/** The plain refusal every part of the pipeline gives while the LTX rates are missing (one text, one message to the owner). */
export const LTX_RATES_MISSING =
  "LTX clips are not set up: the three rates runpodLtxUsdPerSec, runpodLtxSecPerClipSec and runpodLtxColdStartSec are not all set in prices.json";
