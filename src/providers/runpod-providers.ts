import { readFile } from "node:fs/promises";
import type { RunpodRates } from "../config.js";
import type { R2 } from "./r2.js";
import { NonRetryableError, UnusableResultError } from "./retry.js";
import type { RunpodClient, RunpodJob, RunpodPolicy } from "./runpod.js";
import type {
  ImageOutput, ImageProvider, ImageRequest, PreparedJob, SubmitOptions, VideoOutput, VideoProvider, VideoRequest,
  WaitOptions,
} from "./types.js";

/** `/run` accepts at most 10 MB; base64 images are checked against this before anything is bought. */
export const MAX_INPUT_BYTES = 9 * 1024 * 1024;

/** Frames per second Wan generates at (2.4 spec §5.3). */
export const WAN_FPS = 16;

export type RunpodDeps = {
  client: RunpodClient;
  r2: R2;
  rates: RunpodRates;
  /** Where warnings go (default: the console, like the CLI's own log). */
  log?: (message: string) => void;
  poll?: { pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };
};

type Target = { endpointId: string; workflow: string; version: number };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) throw new NonRetryableError("not a PNG image");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Frames a clip of `durationSec` needs at 16 fps: 4k+1 between 33 and 81 (2.4 spec §5.3). */
export function clipFrames(durationSec: number): number {
  const frames = Math.round(durationSec * WAN_FPS);
  if (frames < 33 || frames > 81 || (frames - 1) % 4 !== 0) {
    throw new NonRetryableError(`a Wan clip must be 4k+1 frames between 33 and 81 at ${WAN_FPS} fps; got ${durationSec} s (${frames})`);
  }
  return frames;
}

/**
 * One RunPod endpoint behind the queued-provider contract: one submit, read-only polling, and the job's
 * measured GPU time as its cost. A job RunPod has already forgotten (404 after its 30-minute result window)
 * is recovered from the bucket the worker uploaded to; its cost is then left to the stage's estimate.
 */
abstract class RunpodQueued<Req, Out extends { url: string; costUsd?: number; remove?: () => Promise<void> }> {
  /**
   * A RunPod job carries its image inside the submit request (3–5 MB as base64), where fal uploads it during
   * `prepare`. On a slow uplink that took over the 60 s default twice in one live run (3.1 spec §16).
   */
  readonly submitMs = 180_000;

  constructor(
    protected readonly deps: RunpodDeps,
    protected readonly target: Target,
    private readonly policy: RunpodPolicy,
    readonly waitMs: number,
    private readonly ext: "png" | "mp4",
  ) {}

  protected abstract input(req: Req): Promise<Record<string, unknown>>;
  protected abstract usdPerSec(): number;
  protected abstract output(jobId: string, out: { url: string; seed?: number }, costUsd: number | undefined): Out;

  async prepare(req: Req): Promise<PreparedJob> {
    const input = { ...(await this.input(req)), workflow: `${this.target.workflow}@${this.target.version}` };
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (bytes > MAX_INPUT_BYTES) {
      throw new NonRetryableError(`RunPod input is ${(bytes / 1048576).toFixed(1)} MB; the limit is 9 MB`);
    }
    return { input };
  }

  async submit(job: PreparedJob, opts: SubmitOptions): Promise<string> {
    return this.deps.client.run(this.target.endpointId, job.input, this.policy, opts.signal);
  }

  protected cost(job: RunpodJob): number | undefined {
    if (typeof job.executionTime !== "number") return undefined;
    return Math.round((job.executionTime / 1000) * this.usdPerSec() * 10_000) / 10_000;
  }

  /** A failed or timed-out job that reports no execution time never reached a GPU, so it cost nothing. */
  private failedCost(job: RunpodJob): number {
    return typeof job.executionTime === "number" && job.executionTime > 0 ? (this.cost(job) ?? 0) : 0;
  }

  async wait(jobId: string, opts: WaitOptions): Promise<Out> {
    const { pollMs = 3000, sleep = realSleep, now = Date.now } = this.deps.poll ?? {};
    const deadline = now() + opts.timeoutMs;
    for (;;) {
      const job = await this.deps.client.status(this.target.endpointId, jobId);
      if (job === null) return this.recover(jobId);
      if (job.status === "COMPLETED") {
        const out = job.output as { url?: unknown; seed?: unknown } | undefined;
        if (typeof out?.url !== "string") {
          throw new UnusableResultError(`RunPod job ${jobId} completed without an output url`, this.cost(job));
        }
        const cost = this.cost(job);
        if (cost === 0 && job.executionTime !== undefined) {
          (this.deps.log ?? console.warn)(
            `RunPod job ${jobId} completed with executionTime ${job.executionTime} but a measured cost of $0; ` +
              `is executionTime still in milliseconds?`,
          );
        }
        return this.removable(jobId, this.output(jobId, { url: out.url, seed: typeof out.seed === "number" ? out.seed : undefined }, cost));
      }
      if (job.status === "FAILED" || job.status === "TIMED_OUT") {
        const why = job.status === "TIMED_OUT" ? "ran past its execution timeout" : `failed: ${JSON.stringify(job.error)}`;
        throw new UnusableResultError(`RunPod job ${jobId} ${why}`, this.failedCost(job));
      }
      if (job.status === "CANCELLED") throw new NonRetryableError(`RunPod job ${jobId} was cancelled`);
      if (now() >= deadline) {
        throw new NonRetryableError(`RunPod job ${jobId} is still ${job.status} after ${Math.round(opts.timeoutMs / 1000)} s`);
      }
      await sleep(pollMs);
    }
  }

  private async recover(jobId: string): Promise<Out> {
    const key = `flowchain/${jobId}.${this.ext}`;
    if (!(await this.deps.r2.exists(key))) {
      throw new NonRetryableError(
        `RunPod no longer knows job ${jobId} and its output ${key} is not in the bucket; reroll to buy a new one`,
      );
    }
    return this.removable(jobId, this.output(jobId, { url: await this.deps.r2.presignGet(key) }, undefined));
  }

  /**
   * The output with the way to take it out of the bucket. Best effort: a file that could not be removed is
   * no reason to lose a result that was paid for and is already here.
   */
  private removable(jobId: string, out: Out): Out {
    const key = `flowchain/${jobId}.${this.ext}`;
    return { ...out, remove: () => this.deps.r2.delete(key).catch(() => {}) };
  }
}

/** Keyframes (and the reference portrait) from the SDXL worker (2.4 spec §5.1–5.2). */
export class RunpodImage extends RunpodQueued<ImageRequest, ImageOutput> implements ImageProvider {
  constructor(deps: RunpodDeps, target: Target) {
    super(deps, target, { executionTimeout: 120_000, ttl: 3_600_000 }, 10 * 60_000, "png");
  }

  protected async input(req: ImageRequest) {
    return {
      task: "keyframe",
      prompt: req.prompt,
      width: req.width,
      height: req.height,
      ...(req.preset === undefined ? {} : { preset: req.preset }),
      ...(req.seed === undefined ? {} : { seed: req.seed }),
      ...(req.referenceImagePath === undefined
        ? {}
        : { reference: (await readFile(req.referenceImagePath)).toString("base64") }),
    };
  }

  protected usdPerSec() {
    return this.deps.rates.keyframeUsdPerSec;
  }

  protected output(_jobId: string, out: { url: string; seed?: number }, costUsd: number | undefined): ImageOutput {
    return { url: out.url, seed: out.seed ?? -1, ...(costUsd === undefined ? {} : { costUsd }) };
  }
}

/** The size a clip is generated at: 480p unless the run asks for 720p, upright or on its side like its picture. */
export function clipSize(short: number | undefined, portrait: boolean): { width: number; height: number } {
  if (short !== undefined && short !== 480 && short !== 720) throw new NonRetryableError(`a clip is made at 480p or 720p, not ${short}p`);
  const [a, b] = short === 720 ? [720, 1280] : [480, 832];
  return portrait ? { width: a, height: b } : { width: b, height: a };
}

/** Clips from the Wan 2.2 worker (2.4 spec §5.3): 480p or 720p in the chain image's orientation. */
export class RunpodVideo extends RunpodQueued<VideoRequest, VideoOutput> implements VideoProvider {
  constructor(deps: RunpodDeps, target: Target) {
    super(deps, target, { executionTimeout: 600_000, ttl: 3_600_000 }, 20 * 60_000, "mp4");
  }

  protected async input(req: VideoRequest) {
    const png = await readFile(req.imagePath);
    const { width, height } = pngSize(png);
    const portrait = height >= width;
    return {
      task: "clip",
      image: png.toString("base64"),
      prompt: req.prompt,
      frames: clipFrames(req.durationSec),
      fps: WAN_FPS,
      ...clipSize(req.height, portrait),
    };
  }

  protected usdPerSec() {
    return this.deps.rates.clipUsdPerSec;
  }

  protected output(_jobId: string, out: { url: string }, costUsd: number | undefined): VideoOutput {
    return { url: out.url, ...(costUsd === undefined ? {} : { costUsd }) };
  }

  /**
   * Asks the worker to start and read its model files, while the run is still making pictures: the first clip
   * then finds a worker that is up instead of waiting for one (phase 5 spec §9.15). The job makes nothing and
   * uploads nothing; it is billed for the seconds the start takes, as the first clip was before.
   */
  async warm(opts: SubmitOptions): Promise<string> {
    return this.deps.client.run(this.target.endpointId, { task: "warm" }, { executionTimeout: 300_000, ttl: 900_000 }, opts.signal);
  }

  async warmCost(jobId: string, opts: WaitOptions): Promise<number> {
    const { pollMs = 3000, sleep = realSleep, now = Date.now } = this.deps.poll ?? {};
    const deadline = now() + opts.timeoutMs;
    for (;;) {
      const job = await this.deps.client.status(this.target.endpointId, jobId);
      if (job === null) throw new NonRetryableError(`RunPod no longer knows warm-up ${jobId}`);
      if (job.status === "COMPLETED") {
        const cost = this.cost(job);
        if (cost === undefined) throw new NonRetryableError(`RunPod warm-up ${jobId} reports no execution time`);
        return cost;
      }
      // one that never reached a GPU cost nothing; one that ran and then failed cost what it ran
      if (job.status === "FAILED" || job.status === "TIMED_OUT" || job.status === "CANCELLED") {
        return typeof job.executionTime === "number" && job.executionTime > 0 ? (this.cost(job) ?? 0) : 0;
      }
      if (now() >= deadline) throw new NonRetryableError(`RunPod warm-up ${jobId} is still ${job.status}`);
      await sleep(pollMs);
    }
  }
}
