import { readFile } from "node:fs/promises";
import { createFalClient, type FalClient } from "@fal-ai/client";
import type { ImageProvider, ImageRequest, VideoProvider, VideoRequest } from "./types.js";

export type FalLike = Pick<FalClient, "subscribe" | "storage">;

export function createFal(apiKey: string): FalLike {
  return createFalClient({ credentials: apiKey });
}

export class FalImage implements ImageProvider {
  constructor(
    private readonly fal: FalLike,
    readonly model: string,
  ) {}

  async generate(req: ImageRequest): Promise<{ url: string; seed: number }> {
    const result = await this.fal.subscribe(this.model, {
      input: {
        prompt: req.prompt,
        image_size: { width: req.width, height: req.height },
        num_images: 1,
        num_inference_steps: 28,
        guidance_scale: 3.5,
        output_format: "png",
        enable_safety_checker: true,
        ...(req.seed === undefined ? {} : { seed: req.seed }),
      },
    });
    const data = result.data as { images: Array<{ url: string }>; seed: number };
    return { url: data.images[0].url, seed: data.seed };
  }
}

/** Kling v2.1 takes its aspect ratio from the input image. */
export class FalVideo implements VideoProvider {
  constructor(
    private readonly fal: FalLike,
    readonly model: string,
  ) {}

  async imageToVideo(req: VideoRequest): Promise<{ url: string }> {
    const image = new Blob([await readFile(req.imagePath)], { type: "image/png" });
    const imageUrl = await this.fal.storage.upload(image);
    const result = await this.fal.subscribe(this.model, {
      input: {
        image_url: imageUrl,
        prompt: req.prompt,
        duration: String(req.durationSec),
        negative_prompt: "blur, distortion, low quality, text, watermark, morphing faces",
        cfg_scale: 0.5,
      },
    });
    return { url: (result.data as { video: { url: string } }).video.url };
  }
}

/** Validates the key with a free storage upload (no generation cost). */
export async function checkFal(fal: FalLike): Promise<void> {
  await fal.storage.upload(new Blob(["flowchain doctor"], { type: "text/plain" }));
}
