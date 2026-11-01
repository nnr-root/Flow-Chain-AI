import { type Env, foleyRates, flux3Rates, ltxRates, type Prices, RESTORE_RATES_MISSING, restoreRates, runpodRates } from "../config.js";
import type { ImageProfileId } from "../image-profiles.js";
import { CLIP_QUALITIES, type ClipQuality, type VideoProfileId } from "../video-profiles.js";
import { hostedModelFor } from "../voice/hosted.js";
import { canSpeakIn, OWN_VOICE_LANGUAGES } from "../voice/language.js";
import { RUNPOD_WORKFLOWS, runpodModelId } from "./model-id.js";

export type NewRunProviders = { image: string; video: string; imageProfile: ImageProfileId; videoProfile: VideoProfileId };

/**
 * The picture model a new run is frozen with: FLUX 3 klein while it is set up, else the 4B. Apart from the clips so that
 * tools which only draw pictures (make:styles, make:voices) never depend on the clip endpoint or on LTX.
 */
export function newRunImage(env: Env, prices?: Prices): { image: string; imageProfile: ImageProfileId } {
  const ready = Boolean(env.RUNPOD_PICTURE3_ENDPOINT) && prices !== undefined && flux3Rates(prices) !== null;
  if (env.FLOWCHAIN_IMAGE_MODEL === "flux3" && !ready) {
    throw new Error("FLOWCHAIN_IMAGE_MODEL=flux3 but FLUX 3 is not set up: set RUNPOD_PICTURE3_ENDPOINT and the four runpodPicture3* prices in prices.json");
  }
  const flux3 = ready && env.FLOWCHAIN_IMAGE_MODEL !== "klein4b";
  if (!flux3 && !env.RUNPOD_KEYFRAME_ENDPOINT) throw new Error("RUNPOD_KEYFRAME_ENDPOINT not set; run npm run runpod:deploy first");
  const { keyframe, keyframe3 } = RUNPOD_WORKFLOWS;
  return flux3
    ? { image: runpodModelId(env.RUNPOD_PICTURE3_ENDPOINT!, keyframe3.workflow, keyframe3.version), imageProfile: "runpod-flux3-klein@1" }
    : { image: runpodModelId(env.RUNPOD_KEYFRAME_ENDPOINT!, keyframe.workflow, keyframe.version), imageProfile: "runpod-klein@1" };
}

/** The models and cost profiles a new run is frozen with: the studio's own GPU endpoints (2.4 spec §3.4). */
export function newRunProviders(env: Env, clips: ClipQuality = "480p", prices?: Prices): NewRunProviders {
  // LTX takes the clips only when the owner switched it on and its endpoint and all three of its rates are set
  // (phase 15 spec §7, §13.8): `runpod:deploy` writes the endpoint before the owner has measured the rates, and
  // `server:setup` passes both on to the server, so the switch is what keeps customers on Wan until the licence is
  // answered. Otherwise every new run is made on Wan exactly as before. The switch decides new runs only: a run already
  // made on LTX resumes with its rates whatever it says, and still refuses to resume without them (`createProviders`, the
  // profile's cost). The requested clip quality (`clips`) is ignored for an LTX run: it has one size.
  const ltx = env.FLOWCHAIN_LTX === "on" && Boolean(env.RUNPOD_LTX_ENDPOINT) && prices !== undefined && ltxRates(prices) !== undefined;
  // The clip endpoint is checked first and the picture side after, as the two were named together in one message before.
  const needClip = !ltx && !env.RUNPOD_CLIP_ENDPOINT;
  let image: ReturnType<typeof newRunImage>;
  try {
    image = newRunImage(env, prices);
  } catch (e) {
    if (needClip && e instanceof Error && e.message.startsWith("RUNPOD_KEYFRAME_ENDPOINT not set")) {
      throw new Error("RUNPOD_KEYFRAME_ENDPOINT and RUNPOD_CLIP_ENDPOINT not set; run npm run runpod:deploy first");
    }
    throw e;
  }
  if (needClip) throw new Error("RUNPOD_CLIP_ENDPOINT not set; run npm run runpod:deploy first");
  const { clip, clipLtx } = RUNPOD_WORKFLOWS;
  return {
    ...image,
    video: ltx ? runpodModelId(env.RUNPOD_LTX_ENDPOINT!, clipLtx.workflow, clipLtx.version) : runpodModelId(env.RUNPOD_CLIP_ENDPOINT!, clip.workflow, clip.version),
    videoProfile: ltx ? "ltx25@1" : CLIP_QUALITIES[clips],
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
export function restorerFor(opts: { fps?: string; upscale?: boolean; videoProfile?: VideoProfileId }, env: Env, prices: Prices): string | undefined {
  // smooth motion was measured on Wan's 16 fps clips only; an LTX clip is 24 (phase 15 spec §13.5). Refused now, before
  // anything is bought, in words that name no model (the studio's job log shows them)
  if (opts.fps === "60" && opts.videoProfile === "ltx25@1") {
    throw new Error("smooth motion is not available yet for clips made at 24 frames a second");
  }
  if (opts.fps === "60") return newRunRestore(env, prices);
  if (opts.upscale) return newRunUpscale(env);
  return undefined;
}

/**
 * Whether a new run is made with scene sound (phase 14 spec §3, plan ruling 4), and on which model: only while the run
 * has sound effects, the switch is on, the Foley endpoint is set and its three prices are there. Off says nothing in the
 * ordinary cases (the switch off, a run without sound effects); only a switch that is on with something it needs missing
 * gives the one line `say`, for the owner. That line reaches a customer's job log, so it names no setting or flag.
 */
export function newRunSound(env: Env, prices: Prices, sfx: boolean): { model: string } | { say?: string } {
  if (!sfx || env.FLOWCHAIN_SCENE_SOUND !== "on") return {};
  if (!env.RUNPOD_FOLEY_ENDPOINT) return { say: "scene sound is on but no sound endpoint is set; this run is made without it" };
  if (!foleyRates(prices)) return { say: "scene sound is on but its prices are not set; this run is made without it" };
  const { sound } = RUNPOD_WORKFLOWS;
  return { model: runpodModelId(env.RUNPOD_FOLEY_ENDPOINT, sound.workflow, sound.version) };
}

/**
 * Whether a new run lets a character speak (phase 15 spec §5): only when it asked to, its clips are made on LTX (the one
 * engine whose clip carries speech: its endpoint and rates are set), the owner switched speech on, and the video is in
 * a language speech was measured in (`canSpeakIn`). Anything else that asks is refused here, at creation, before
 * anything is bought, so no run is ever frozen with speech it cannot have. The words reach a customer's job log, so they
 * name no model and no setting.
 */
export function newRunSpeech(env: Env, videoProfile: VideoProfileId, asked: boolean | undefined, language: string | undefined): boolean {
  if (!asked) return false;
  if (videoProfile !== "ltx25@1" || env.FLOWCHAIN_SPEECH !== "on") throw new Error("speaking characters are not available in this studio");
  if (!canSpeakIn(language)) throw new Error("a character can speak only in a video in English or Turkish");
  return true;
}

/**
 * What a run that lets a character speak is frozen with: speech, and a speaking clip as long as its sentence (phase 15
 * spec §13.6). A run frozen before the second has its clips at the longest, as they were bought.
 */
export const SPEECH_REQUEST = { speech: true, speakingClip: "sentence" } as const;

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
