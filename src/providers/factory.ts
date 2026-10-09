import { type Env, type Prices, runpodRates } from "../config.js";
import type { Models } from "../manifest/schema.js";
import { ElevenLabsTts } from "./elevenlabs.js";
import { GeminiLlm } from "./gemini.js";
import { parseModelId } from "./model-id.js";
import { R2 } from "./r2.js";
import { RunpodClient } from "./runpod.js";
import { type RunpodDeps, RunpodImage, RunpodVideo } from "./runpod-providers.js";
import { NonRetryableError } from "./retry.js";
import { RunpodTts } from "./runpod-voice.js";
import type { ImageProvider, Providers, QueuedProvider, TtsProvider, VideoProvider } from "./types.js";

function need(value: string | undefined, name: string, why: string): string {
  if (!value) throw new Error(`${name} is not set; ${why}`);
  return value;
}

/**
 * Stands in for a hosted model the studio stopped buying from (phase 5 spec §5.1). Everything already bought for
 * such a run is on disk, so it re-renders for free; the first step that would buy something says why it cannot.
 */
export function retired<Req, Out>(what: string, model: string): QueuedProvider<Req, Out> {
  const refuse = (): never => {
    throw new NonRetryableError(
      `this run's ${what} came from ${model}, a hosted model this studio no longer uses; it can be re-rendered (rerender), but nothing new can be bought for it — start a new run instead`,
    );
  };
  return { prepare: async () => refuse(), submit: async () => refuse(), wait: async () => refuse() };
}

/**
 * The providers for one run, chosen by the run's own (frozen) model ids, so a run keeps the endpoints and graphs
 * it was made with whenever it is resumed, rerolled or rerendered (2.4 spec §3.4).
 */
export function createProviders(env: Env, models: Models, prices: Prices): Providers {
  const imageRef = parseModelId(models.image);
  const videoRef = parseModelId(models.video);
  let runpod: RunpodDeps | undefined;
  const runpodDeps = () =>
    (runpod ??= {
      client: new RunpodClient(need(env.RUNPOD_API_KEY, "RUNPOD_API_KEY", "this run uses RunPod")),
      r2: new R2({
        accountId: need(env.R2_ACCOUNT_ID, "R2_ACCOUNT_ID", "RunPod outputs are read from R2"),
        bucket: need(env.R2_BUCKET, "R2_BUCKET", "RunPod outputs are read from R2"),
        accessKeyId: need(env.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID", "RunPod outputs are read from R2"),
        secretAccessKey: need(env.R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY", "RunPod outputs are read from R2"),
      }),
      rates: runpodRates(prices),
    });
  const image: ImageProvider =
    imageRef.provider === "retired" ? retired("pictures", imageRef.model) : new RunpodImage(runpodDeps(), imageRef);
  const video: VideoProvider =
    videoRef.provider === "retired" ? retired("clips", videoRef.model) : new RunpodVideo(runpodDeps(), videoRef);
  // The voice follows the run too: a run spoken by the studio's own voice stays there, an earlier one stays on
  // the service it was made with for as long as that service's key is here.
  const voiceRef = models.tts.startsWith("runpod:") ? parseModelId(models.tts) : undefined;
  const tts: TtsProvider =
    voiceRef?.provider === "runpod"
      ? new RunpodTts({ client: new RunpodClient(need(env.RUNPOD_API_KEY, "RUNPOD_API_KEY", "this run uses the studio's own voice")), usdPerSec: runpodRates(prices).voiceUsdPerSec }, voiceRef)
      : new ElevenLabsTts(need(env.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY", "this run's voice is ElevenLabs"), models.tts);
  return {
    llm: new GeminiLlm(env.GEMINI_API_KEY, models.llm),
    tts,
    image,
    video,
  };
}
