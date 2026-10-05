import { z } from "zod";
import type { Prices } from "./config.js";
import { videoCost } from "./cost.js";

export const VideoProfileId = z.enum(["kling-v1", "kling-v2"]);
export type VideoProfileId = z.infer<typeof VideoProfileId>;

/**
 * How a video model is bought (2.3 spec §7): the clip length to request for a scene's trimmed narration, and
 * its price. A provider billed per second (e.g. Wan on RunPod) adds a profile here; nothing else changes.
 */
export type VideoProfile = {
  id: VideoProfileId;
  clipSec(narrationSec: number): number;
  costUsd(prices: Prices, clipSec: number): number;
};

export const VIDEO_PROFILES: Record<VideoProfileId, VideoProfile> = {
  /** Runs made before 2.3: the shortest Kling length (5 or 10 s) that covers the narration. */
  "kling-v1": { id: "kling-v1", clipSec: (s) => (s <= 5 ? 5 : 10), costUsd: videoCost },
  /** Kling's 5 s clip (≈ 5.04 s) also covers up to 6.0 s: the fit step slows it by at most ≈ 1.19×. */
  "kling-v2": { id: "kling-v2", clipSec: (s) => (s <= 6 ? 5 : 10), costUsd: videoCost },
};

/** The profile new runs are created with. */
export const NEW_RUN_VIDEO_PROFILE: VideoProfileId = "kling-v2";

/** A run's profile; runs without one were created before 2.3 and keep the Phase 1 rule. */
export function videoProfileOf(id: VideoProfileId | undefined): VideoProfile {
  return VIDEO_PROFILES[id ?? "kling-v1"];
}
