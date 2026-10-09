import { z } from "zod";
import { type Prices, runpodRates } from "./config.js";
import { round4, videoCost } from "./cost.js";

export const VideoProfileId = z.enum(["kling-v1", "kling-v2", "wan22-480p@1", "wan22-720p@1"]);
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

/** Wan's frame rate and the fit step's largest stretch (2.4 spec §5.3). */
const WAN_FPS = 16;
const MAX_STRETCH = 1.25;

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
