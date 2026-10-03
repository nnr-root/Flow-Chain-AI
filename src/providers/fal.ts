import { readFile } from "node:fs/promises";
import { createFalClient, type FalClient } from "@fal-ai/client";
import { NonRetryableError, UnusableResultError } from "./retry.js";
import type {
  ImageOutput, ImageProvider, ImageRequest, PreparedJob, SubmitOptions, VideoOutput, VideoProvider, VideoRequest,
  WaitOptions,
} from "./types.js";

export type FalLike = Pick<FalClient, "queue" | "storage">;

export function createFal(apiKey: string): FalLike {
  return createFalClient({ credentials: apiKey });
}

export type PollOptions = {
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Explicit queue API instead of `subscribe`: the caller persists the request id between `submit` and
 * `wait`, so a timeout, crash or Ctrl-C while waiting never loses (or re-buys) a running job.
 */
abstract class FalQueued<Req, Out> {
  constructor(
    protected readonly fal: FalLike,
    readonly model: string,
    private readonly poll: PollOptions = {},
  ) {}

  protected abstract input(req: Req): Promise<Record<string, unknown>>;
  protected abstract output(requestId: string, data: unknown): Out;

  /** Builds the request body, doing any uploads. Free and safe to repeat. */
  async prepare(req: Req): Promise<PreparedJob> {
    return { input: await this.input(req) };
  }

  /** Buys one job. The client does not retry an aborted request, so aborting abandons the submit. */
  async submit(job: PreparedJob, opts: SubmitOptions): Promise<string> {
    const queued = await this.fal.queue.submit(this.model, { input: job.input, abortSignal: opts.signal });
    return queued.request_id;
  }

  /** Polls status (read-only, safe to repeat) until COMPLETED, then fetches the result. Never resubmits. */
  async wait(requestId: string, opts: WaitOptions): Promise<Out> {
    const { pollMs = 2000, sleep = realSleep, now = Date.now } = this.poll;
    const deadline = now() + opts.timeoutMs;
    for (;;) {
      const status = await this.fal.queue.status(this.model, { requestId });
      if (status.status === "COMPLETED") break;
      if (now() >= deadline) {
        throw new NonRetryableError(
          `fal request ${requestId} is still ${status.status} after ${Math.round(opts.timeoutMs / 1000)} s`,
        );
      }
      await sleep(pollMs);
    }
    const result = await this.fal.queue.result(this.model, { requestId });
    return this.output(requestId, result.data);
  }
}

export class FalImage extends FalQueued<ImageRequest, ImageOutput> implements ImageProvider {
  protected async input(req: ImageRequest) {
    return {
      prompt: req.prompt,
      image_size: { width: req.width, height: req.height },
      num_images: 1,
      num_inference_steps: 28,
      guidance_scale: 3.5,
      output_format: "png",
      enable_safety_checker: true,
      ...(req.seed === undefined ? {} : { seed: req.seed }),
    };
  }

  protected output(requestId: string, data: unknown): ImageOutput {
    const d = (data ?? {}) as { images?: Array<{ url?: string }>; seed?: number; has_nsfw_concepts?: boolean[] };
    if (d.has_nsfw_concepts?.[0] === true) {
      throw new UnusableResultError(
        `fal image request ${requestId} was flagged NSFW by the safety checker (the image is blanked); reroll the keyframe`,
      );
    }
    const url = d.images?.[0]?.url;
    if (!url) throw new UnusableResultError(`fal image request ${requestId} completed without an image (no images[0].url)`);
    return { url, seed: typeof d.seed === "number" ? d.seed : -1 };
  }
}

/** Kling v2.1 takes its aspect ratio from the input image. */
export class FalVideo extends FalQueued<VideoRequest, VideoOutput> implements VideoProvider {
  protected async input(req: VideoRequest) {
    const image = new Blob([await readFile(req.imagePath)], { type: "image/png" });
    const imageUrl = await this.fal.storage.upload(image);
    return {
      image_url: imageUrl,
      prompt: req.prompt,
      duration: String(req.durationSec),
      negative_prompt: "blur, distortion, low quality, text, watermark, morphing faces",
      cfg_scale: 0.5,
    };
  }

  protected output(requestId: string, data: unknown): VideoOutput {
    const url = (data as { video?: { url?: string } } | null)?.video?.url;
    if (!url) throw new UnusableResultError(`fal video request ${requestId} completed without a video (no video.url)`);
    return { url };
  }
}

/** Validates the key with a free storage upload (no generation cost). */
export async function checkFal(fal: FalLike): Promise<void> {
  await fal.storage.upload(new Blob(["flowchain doctor"], { type: "text/plain" }));
}
