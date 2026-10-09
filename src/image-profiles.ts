import { z } from "zod";
import { type Prices, runpodRates, type Size } from "./config.js";
import { imageCost, round4 } from "./cost.js";

export const ImageProfileId = z.enum(["fal-flux@1", "runpod-sdxl@1", "runpod-klein@1"]);
export type ImageProfileId = z.infer<typeof ImageProfileId>;

/** How keyframes are bought (2.4 spec §6): per-job estimates and a once-per-run overhead (cold start). */
export type ImageProfile = {
  id: ImageProfileId;
  keyframeUsd(prices: Prices, size: Size): number;
  referenceUsd(prices: Prices, size: Size): number;
  runOverheadUsd(prices: Prices): number;
};

export const IMAGE_PROFILES: Record<ImageProfileId, ImageProfile> = {
  /** A hosted Flux, priced per megapixel, with no reference image. No longer bought (phase 5 spec §5.1); kept for the runs made with it. */
  "fal-flux@1": {
    id: "fal-flux@1",
    keyframeUsd: imageCost,
    referenceUsd: () => 0,
    runOverheadUsd: () => 0,
  },
  /** The SDXL worker on RunPod, priced by GPU seconds. */
  "runpod-sdxl@1": {
    id: "runpod-sdxl@1",
    keyframeUsd: (p) => round4(runpodRates(p).keyframeSec * runpodRates(p).keyframeUsdPerSec),
    referenceUsd: (p) => round4(runpodRates(p).referenceSec * runpodRates(p).keyframeUsdPerSec),
    runOverheadUsd: (p) => round4(runpodRates(p).coldStartSec * runpodRates(p).keyframeUsdPerSec),
  },
  /** The klein worker: one pass at the final size, and a quick portrait. Priced by GPU seconds (measured, phase 5 spec §9.9–9.10). */
  "runpod-klein@1": {
    id: "runpod-klein@1",
    keyframeUsd: (p) => round4(runpodRates(p).pictureSec * runpodRates(p).keyframeUsdPerSec),
    referenceUsd: (p) => round4(runpodRates(p).portraitSec * runpodRates(p).keyframeUsdPerSec),
    runOverheadUsd: (p) => round4(runpodRates(p).pictureColdStartSec * runpodRates(p).keyframeUsdPerSec),
  },
};

/** Whether a profile's worker keeps a character from a portrait: such a run has a reference stage. */
export const takesReference = (id: ImageProfileId | undefined): boolean => id === "runpod-sdxl@1" || id === "runpod-klein@1";

/** A run's image profile; runs without one were made before 2.4, on the hosted model. */
export function imageProfileOf(id: ImageProfileId | undefined): ImageProfile {
  return IMAGE_PROFILES[id ?? "fal-flux@1"];
}
