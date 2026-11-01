import { z } from "zod";
import { SPEECH_RATE } from "./voice/rates.js";
import { LTX_RATES_MISSING, ltxRates, type Prices, runpodRates } from "./config.js";
import { round4, videoCost } from "./cost.js";

export const VideoProfileId = z.enum(["kling-v1", "kling-v2", "wan22-480p@1", "wan22-720p@1", "ltx25@1"]);
export type VideoProfileId = z.infer<typeof VideoProfileId>;

/**
 * How a video model is bought (2.3 spec §7): the clip length to request for a scene's trimmed narration, and
 * its price. A provider billed per second (e.g. Wan on RunPod) adds a profile here; nothing else changes.
 */
export type VideoProfile = {
  id: VideoProfileId;
  clipSec(narrationSec: number): number;
  costUsd(prices: Prices, clipSec: number): number;
  /** Paid once per run when any clip is bought (a RunPod cold start); 0 for per-clip billing. */
  runOverheadUsd(prices: Prices): number;
  /** The height clips are generated at, where the run chooses it (480 or 720); absent = the provider's own. */
  clipHeight?: number;
};

/** Wan's frame rate and the fit step's largest stretch (2.4 spec §5.3); LTX uses the same stretch. */
const WAN_FPS = 16;
const MAX_STRETCH = 1.25;

/** LTX 2.5's frame rate, and the frame counts it takes: 8k+1, from 2 to 15 seconds (phase 15 spec §3). */
export const LTX_FPS = 24;
export const LTX_MIN_FRAMES = 49;
export const LTX_MAX_FRAMES = 361;

/** Frames for an LTX clip covering `narrationSec` after the fit step's stretch: 8k+1, between 49 and 361. A longer scene is chained. */
export function ltxFrames(narrationSec: number): number {
  const needed = Math.ceil((narrationSec / MAX_STRETCH) * LTX_FPS) + 1;
  const frames = 8 * Math.ceil((needed - 1) / 8) + 1;
  return Math.min(LTX_MAX_FRAMES, Math.max(LTX_MIN_FRAMES, frames));
}

/** A speaking clip's frames, shortest and longest (4.04 s and 7.04 s at 24 fps; phase 15 spec §13.6). */
export const SPEAKING_MIN_FRAMES = 97;
export const SPEAKING_MAX_FRAMES = 169;

/**
 * How many words a second a person in a clip says in `language`: three in English (3.4 was measured in a clip), and in
 * another language three scaled by how its narrators speak against the English ones (`SPEECH_RATE`, measured): Turkish is
 * said about a third slower. Undefined for a language never measured.
 */
export function speakingRate(language: string | undefined): number | undefined {
  const rate = language === undefined ? undefined : SPEECH_RATE[language];
  return rate === undefined ? undefined : 3 * (rate / SPEECH_RATE.en);
}

/**
 * Frames for a speaking clip of a sentence of `words` words said at `rate` words a second (phase 15 spec §13.6): about the
 * sentence's own time and one second more, as 8k+1, between 97 and 169. A clip much longer than its sentence is filled by
 * LTX saying the sentence again. Unknown sentence or rate: the longest.
 */
export function speakingFrames(words?: number, rate?: number): number {
  if (words === undefined || rate === undefined) return SPEAKING_MAX_FRAMES;
  const frames = 8 * Math.ceil(((words / rate + 1) * LTX_FPS) / 8) + 1;
  return Math.min(SPEAKING_MAX_FRAMES, Math.max(SPEAKING_MIN_FRAMES, frames));
}

/** The rates are read when a price is asked for, so a missing one stops the run with a reason instead of costing 0. */
function ltxRatesOf(p: Prices) {
  const r = ltxRates(p);
  if (!r) throw new Error(LTX_RATES_MISSING);
  return r;
}

/** Frames for a Wan clip covering `narrationSec` after the fit step's stretch: 4k+1, between 33 and 81. */
export function wanFrames(narrationSec: number): number {
  const needed = Math.ceil((narrationSec / MAX_STRETCH) * WAN_FPS) + 1;
  const frames = 4 * Math.ceil((needed - 1) / 4) + 1;
  return Math.min(81, Math.max(33, frames));
}

export const VIDEO_PROFILES: Record<VideoProfileId, VideoProfile> = {
  // The two Kling profiles belong to runs made on a hosted model the studio no longer buys from (phase 5 spec
  // §5.1); they stay so those runs' recorded clip lengths and estimates still compute.
  /** Runs made before 2.3: the shortest Kling length (5 or 10 s) that covers the narration. */
  "kling-v1": { id: "kling-v1", clipSec: (s) => (s <= 5 ? 5 : 10), costUsd: videoCost, runOverheadUsd: () => 0 },
  /** Kling's 5 s clip (≈ 5.04 s) also covers up to 6.0 s: the fit step slows it by at most ≈ 1.19×. */
  "kling-v2": { id: "kling-v2", clipSec: (s) => (s <= 6 ? 5 : 10), costUsd: videoCost, runOverheadUsd: () => 0 },
  /** Wan 2.2 on RunPod: only the frames the narration needs, priced by GPU seconds per frame. */
  "wan22-480p@1": {
    id: "wan22-480p@1",
    clipSec: (s) => wanFrames(s) / WAN_FPS,
    costUsd: (p, clipSec) => round4(Math.round(clipSec * WAN_FPS) * runpodRates(p).clipSecPerFrame * runpodRates(p).clipUsdPerSec),
    runOverheadUsd: (p) => round4(runpodRates(p).coldStartSec * runpodRates(p).clipUsdPerSec),
  },
  /** The same model at 720p (phase 5 spec §6.3): the same clip lengths, about 2.2 times the GPU seconds a frame. */
  "wan22-720p@1": {
    id: "wan22-720p@1",
    clipSec: (s) => wanFrames(s) / WAN_FPS,
    costUsd: (p, clipSec) => round4(Math.round(clipSec * WAN_FPS) * runpodRates(p).clip720SecPerFrame * runpodRates(p).clipUsdPerSec),
    runOverheadUsd: (p) => round4(runpodRates(p).coldStartSec * runpodRates(p).clipUsdPerSec),
    clipHeight: 720,
  },
  /** LTX 2.5 on RunPod (phase 15): one size, clips with their own sound, priced by GPU seconds a clip second. */
  "ltx25@1": {
    id: "ltx25@1",
    clipSec: (s) => ltxFrames(s) / LTX_FPS,
    costUsd: (p, clipSec) => {
      const r = ltxRatesOf(p);
      return round4(clipSec * r.secPerClipSec * r.usdPerSec);
    },
    runOverheadUsd: (p) => {
      const r = ltxRatesOf(p);
      return round4(r.coldStartSec * r.usdPerSec);
    },
    // The SHORT side, as 480/720 are for Wan; the provider derives the long side (1152) from the picture's orientation.
    clipHeight: 640,
  },
};

/** What a run may ask for by name, and the profile behind each. */
export const CLIP_QUALITIES = { "480p": "wan22-480p@1", "720p": "wan22-720p@1" } as const satisfies Record<string, VideoProfileId>;
export type ClipQuality = keyof typeof CLIP_QUALITIES;

/** The profile new runs are created with. */
export const NEW_RUN_VIDEO_PROFILE: VideoProfileId = "wan22-480p@1";

/** A run's profile; runs without one were created before 2.3 and keep the Phase 1 rule. */
export function videoProfileOf(id: VideoProfileId | undefined): VideoProfile {
  return VIDEO_PROFILES[id ?? "kling-v1"];
}
