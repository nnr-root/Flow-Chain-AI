import { type Env, FOLEY_RATES_MISSING, foleyRates, flux3Rates, type Prices, RESTORE_RATES_MISSING, restoreRates, runpodRates } from "../config.js";
import type { ImageProfileId } from "../image-profiles.js";
import { CLIP_QUALITIES, type ClipQuality, type VideoProfileId } from "../video-profiles.js";
import { hostedModelFor } from "../voice/hosted.js";
import { OWN_VOICE_LANGUAGES } from "../voice/language.js";
import { RUNPOD_WORKFLOWS, runpodModelId } from "./model-id.js";

export type NewRunProviders = { image: string; video: string; imageProfile: ImageProfileId; videoProfile: VideoProfileId };

/** The models and cost profiles a new run is frozen with: the studio's own GPU endpoints (2.4 spec §3.4). */
export function newRunProviders(env: Env, clips: ClipQuality = "480p", prices?: Prices): NewRunProviders {
  const ready = Boolean(env.RUNPOD_PICTURE3_ENDPOINT) && prices !== undefined && flux3Rates(prices) !== null;
  if (env.FLOWCHAIN_IMAGE_MODEL === "flux3" && !ready) {
    throw new Error("FLOWCHAIN_IMAGE_MODEL=flux3 but FLUX 3 is not set up: set RUNPOD_PICTURE3_ENDPOINT and the four runpodPicture3* prices in prices.json");
  }
  const flux3 = ready && env.FLOWCHAIN_IMAGE_MODEL !== "klein4b";
  const needed = flux3 ? (["RUNPOD_CLIP_ENDPOINT"] as const) : (["RUNPOD_KEYFRAME_ENDPOINT", "RUNPOD_CLIP_ENDPOINT"] as const);
  const missing = needed.filter((k) => !env[k]);
  if (missing.length) throw new Error(`${missing.join(" and ")} not set; run npm run runpod:deploy first`);
  const { keyframe, keyframe3, clip } = RUNPOD_WORKFLOWS;
  return {
    image: flux3 ? runpodModelId(env.RUNPOD_PICTURE3_ENDPOINT!, keyframe3.workflow, keyframe3.version) : runpodModelId(env.RUNPOD_KEYFRAME_ENDPOINT!, keyframe.workflow, keyframe.version),
    video: runpodModelId(env.RUNPOD_CLIP_ENDPOINT!, clip.workflow, clip.version),
    imageProfile: flux3 ? "runpod-flux3-klein@1" : "runpod-klein@1",
    videoProfile: CLIP_QUALITIES[clips],
  };
}

/** The endpoint a new run in full HD has its clips upscaled on (phase 8 spec §8). */
export function newRunUpscale(env: Env): string {
  if (!env.RUNPOD_UPSCALE_ENDPOINT) throw new Error("full HD is not set up in this studio: RUNPOD_UPSCALE_ENDPOINT is not set (npm run runpod:deploy)");
  const { upscale } = RUNPOD_WORKFLOWS;
  return runpodModelId(env.RUNPOD_UPSCALE_ENDPOINT, upscale.workflow, upscale.version);
}

/** The endpoint a new run in smooth motion has its clips restored on (phase 11 spec §3, §4); refuses plainly while it is not set up. */
export function newRunRestore(env: Env, prices: Prices): string {
  if (!env.RUNPOD_UPSCALE_ENDPOINT) throw new Error("smooth motion is not set up in this studio: RUNPOD_UPSCALE_ENDPOINT is not set (npm run runpod:deploy)");
  if (!restoreRates(prices)) throw new Error(RESTORE_RATES_MISSING);
  const { restore } = RUNPOD_WORKFLOWS;
  return runpodModelId(env.RUNPOD_UPSCALE_ENDPOINT, restore.workflow, restore.version);
}

/**
 * The restorer model a new run is frozen with, or none: smooth motion (with or without Full HD) is the restorer's
 * new workflow; Full HD alone stays on the old workflow, so its jobs and keys do not change (phase 11 spec §2).
 */
export function restorerFor(opts: { fps?: string; upscale?: boolean }, env: Env, prices: Prices): string | undefined {
  if (opts.fps === "60") return newRunRestore(env, prices);
  if (opts.upscale) return newRunUpscale(env);
  return undefined;
}

/**
 * Whether a new run is made with scene sound (phase 14 spec §3, plan ruling 4), and on which model: only while the run
 * has sound effects, the switch is on, the Foley endpoint is set and its three prices are there. Otherwise the reason it
 * is off, for the one line the run says it with.
 */
export function newRunSound(env: Env, prices: Prices, sfx: boolean): { model: string } | { off: string } {
  if (!sfx) return { off: "the run has no sound effects (--no-sfx)" };
  if (env.FLOWCHAIN_SCENE_SOUND !== "on") return { off: "FLOWCHAIN_SCENE_SOUND is not on" };
  if (!env.RUNPOD_FOLEY_ENDPOINT) return { off: "RUNPOD_FOLEY_ENDPOINT is not set" };
  if (!foleyRates(prices)) return { off: FOLEY_RATES_MISSING };
  const { sound } = RUNPOD_WORKFLOWS;
  return { model: runpodModelId(env.RUNPOD_FOLEY_ENDPOINT, sound.workflow, sound.version) };
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
