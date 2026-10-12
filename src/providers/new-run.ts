import { type Env, type Prices, runpodRates } from "../config.js";
import type { ImageProfileId } from "../image-profiles.js";
import { CLIP_QUALITIES, type ClipQuality, type VideoProfileId } from "../video-profiles.js";
import { hostedModelFor } from "../voice/hosted.js";
import { OWN_VOICE_LANGUAGES } from "../voice/language.js";
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

/**
 * The voice a new run is frozen with: the hosted voice while its key is set (phase 5 spec §11), in the model that
 * speaks the run's language (`hostedModelFor`), else the studio's own (§6.1), which speaks only its own languages.
 * The run's voice is one of the studio's voices (`FLOWCHAIN_VOICE`, or the one the studio asks for); the hosted
 * service's voice for it is chosen line by line from the catalogue, by the run's language.
 */
export function newRunVoice(env: Env, language?: string): { model: string; voiceId: string } {
  if (env.ELEVENLABS_API_KEY) return { model: hostedModelFor(language, env.ELEVENLABS_MODEL), voiceId: env.FLOWCHAIN_VOICE };
  if (!env.RUNPOD_VOICE_ENDPOINT) throw new Error("no voice is set up: set ELEVENLABS_API_KEY (the hosted voice), or run npm run voice:deploy (the studio's own)");
  if (language && !(OWN_VOICE_LANGUAGES as readonly string[]).includes(language)) {
    throw new Error(`the studio's own voice does not speak "${language}": set ELEVENLABS_API_KEY to make a video in it`);
  }
  const { voice } = RUNPOD_WORKFLOWS;
  return { model: runpodModelId(env.RUNPOD_VOICE_ENDPOINT, voice.workflow, voice.version), voiceId: env.FLOWCHAIN_VOICE };
}
