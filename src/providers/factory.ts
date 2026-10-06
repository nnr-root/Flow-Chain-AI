import { type Env, type Prices, runpodRates } from "../config.js";
import type { Models } from "../manifest/schema.js";
import { ElevenLabsTts } from "./elevenlabs.js";
import { createFal, FalImage, FalVideo, type FalLike } from "./fal.js";
import { GeminiLlm } from "./gemini.js";
import { parseModelId } from "./model-id.js";
import { R2 } from "./r2.js";
import { RunpodClient } from "./runpod.js";
import { type RunpodDeps, RunpodImage, RunpodVideo } from "./runpod-providers.js";
import type { ImageProvider, Providers, VideoProvider } from "./types.js";

function need(value: string | undefined, name: string, why: string): string {
  if (!value) throw new Error(`${name} is not set; ${why}`);
  return value;
}

/**
 * The providers for one run, chosen by the run's own (frozen) model ids, never by PROVIDER_MODE, so a fal run
 * stays on fal and a RunPod run stays on RunPod whenever it is resumed, rerolled or rerendered (2.4 spec §3.4).
 */
export function createProviders(env: Env, models: Models, prices: Prices): Providers {
  const imageRef = parseModelId(models.image);
  const videoRef = parseModelId(models.video);
  let fal: FalLike | undefined;
  const falClient = () => (fal ??= createFal(need(env.FAL_KEY, "FAL_KEY", "this run uses fal models")));
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
    imageRef.provider === "fal" ? new FalImage(falClient(), imageRef.model) : new RunpodImage(runpodDeps(), imageRef);
  const video: VideoProvider =
    videoRef.provider === "fal" ? new FalVideo(falClient(), videoRef.model) : new RunpodVideo(runpodDeps(), videoRef);
  return {
    llm: new GeminiLlm(env.GEMINI_API_KEY, models.llm),
    tts: new ElevenLabsTts(env.ELEVENLABS_API_KEY, models.tts),
    image,
    video,
  };
}
