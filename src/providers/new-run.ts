import { type Env, type Prices, runpodRates } from "../config.js";
import type { ImageProfileId } from "../image-profiles.js";
import { CLIP_QUALITIES, type ClipQuality, type VideoProfileId } from "../video-profiles.js";
import { RUNPOD_WORKFLOWS, runpodModelId } from "./model-id.js";

export type NewRunProviders = { image: string; video: string; imageProfile: ImageProfileId; videoProfile: VideoProfileId };

/** The models and cost profiles a new run is frozen with: the studio's own GPU endpoints (2.4 spec §3.4). */
export function newRunProviders(env: Env, clips: ClipQuality = "480p"): NewRunProviders {
  const missing = (["RUNPOD_KEYFRAME_ENDPOINT", "RUNPOD_CLIP_ENDPOINT"] as const).filter((k) => !env[k]);
  if (missing.length) throw new Error(`${missing.join(" and ")} not set; run npm run runpod:deploy first`);
  const { keyframe, clip } = RUNPOD_WORKFLOWS;
  return {
    image: runpodModelId(env.RUNPOD_KEYFRAME_ENDPOINT!, keyframe.workflow, keyframe.version),
    video: runpodModelId(env.RUNPOD_CLIP_ENDPOINT!, clip.workflow, clip.version),
    imageProfile: "runpod-klein@1",
    videoProfile: CLIP_QUALITIES[clips],
  };
}

/**
 * The price table an auto run freezes for its mode rules, with the GPU rates materialised, so a later change to
 * their defaults or to prices.json cannot change what the run plans.
 */
export function frozenModePrices(prices: Prices): Prices {
  const r = runpodRates(prices);
  return {
    ...prices,
    runpodKeyframeUsdPerSec: r.keyframeUsdPerSec,
    runpodClipUsdPerSec: r.clipUsdPerSec,
    runpodKeyframeSec: r.keyframeSec,
    runpodReferenceSec: r.referenceSec,
    runpodClipSecPerFrame: r.clipSecPerFrame,
    runpodColdStartSec: r.coldStartSec,
  };
}

/** The voice a new run is frozen with: the studio's own (phase 5 spec §6.1). */
export function newRunVoice(env: Env): { model: string; voiceId: string } {
  if (!env.RUNPOD_VOICE_ENDPOINT) throw new Error("RUNPOD_VOICE_ENDPOINT not set; run npm run voice:deploy first");
  const { voice } = RUNPOD_WORKFLOWS;
  return { model: runpodModelId(env.RUNPOD_VOICE_ENDPOINT, voice.workflow, voice.version), voiceId: env.FLOWCHAIN_VOICE };
}
