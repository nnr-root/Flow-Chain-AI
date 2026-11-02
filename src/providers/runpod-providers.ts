import { readFile } from "node:fs/promises";
import type { RunpodRates } from "../config.js";
import { shrinkReference } from "../media/reference-image.js";
import { LTX_FPS, LTX_MAX_FRAMES, LTX_MIN_FRAMES } from "../video-profiles.js";
import { RUNPOD_WORKFLOWS } from "./model-id.js";
import type { R2 } from "./r2.js";
import { NonRetryableError, UnusableResultError } from "./retry.js";
import type { RunpodClient, RunpodJob, RunpodPolicy } from "./runpod.js";
import type {
  ImageOutput, ImageProvider, ImageRequest, PreparedJob, SoundOutput, SoundProvider, SoundRequest, SubmitOptions, UpscaleProvider, UpscaleRequest, VideoOutput,
  VideoProvider, VideoRequest, WaitOptions,
} from "./types.js";
import { HeardWord } from "../manifest/heard-word.js";
import type { WordTiming } from "../manifest/schema.js";

/** `/run` accepts at most 10 MB; base64 images are checked against this before anything is bought. */
export const MAX_INPUT_BYTES = 9 * 1024 * 1024;

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
    private readonly ext: "png" | "mp4" | "wav",
  ) {}

  protected abstract input(req: Req): Promise<Record<string, unknown>>;
  protected abstract usdPerSec(): number;
  /**
   * `raw`: the whole of what the worker answered, for a provider that reads more than the url and the seed. Absent when
   * the job was recovered from the bucket: then nothing but the file is known, and the provider must say so.
   */
  protected abstract output(jobId: string, out: { url: string; seed?: number }, costUsd: number | undefined, raw?: Record<string, unknown>): Out;

  /** Whether the job names its workflow: every worker reads it but the LTX one, whose contract refuses any field it does not list. */
  protected withWorkflowKey(): boolean {
    return true;
  }

  async prepare(req: Req): Promise<PreparedJob> {
    const fields = await this.input(req);
    const input = this.withWorkflowKey() ? { ...fields, workflow: `${this.target.workflow}@${this.target.version}` } : fields;
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
        return this.removable(jobId, this.output(jobId, { url: out.url, seed: typeof out.seed === "number" ? out.seed : undefined }, cost, out as Record<string, unknown>));
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

/**
 * A job's own execution limit replaces the endpoint's, so the 300 s the deploy sets for FLUX 3 only counts if the
 * job says so too: its first job loads about 20 GB of weights and then runs 16 steps with up to three references.
 * The wait and the ttl are the same as the 4B's: a queued job that is picked up late is waited for either way.
 */
const FLUX3_EXECUTION_TIMEOUT_MS = 300_000;

/** Keyframes (and the reference portrait) from the SDXL worker (2.4 spec §5.1–5.2). */
export class RunpodImage extends RunpodQueued<ImageRequest, ImageOutput> implements ImageProvider {
  constructor(deps: RunpodDeps, target: Target) {
    super(
      deps,
      target,
      { executionTimeout: target.workflow === RUNPOD_WORKFLOWS.keyframe3.workflow ? FLUX3_EXECUTION_TIMEOUT_MS : 120_000, ttl: 3_600_000 },
      10 * 60_000,
      "png",
    );
  }

  protected async input(req: ImageRequest) {
    return {
      task: "keyframe",
      prompt: req.prompt,
      width: req.width,
      height: req.height,
      // The style's name is not sent. The worker makes every style from the words of the prompt and uses the
      // name for nothing, but it refuses one it does not know, and the one that is deployed knows only the six
      // styles there were when it was built: a picture in any of the eight added since was refused outright
      // (found on 2026-10-10, making the styles' own pictures). What a worker does not need is not a reason
      // for it to stop a video.
      ...(req.seed === undefined ? {} : { seed: req.seed }),
      ...(req.referenceImagePath === undefined
        ? {}
        : { reference: (await readFile(req.referenceImagePath)).toString("base64") }),
      ...(req.referenceImagePaths === undefined || req.referenceImagePaths.length === 0
        ? {}
        : { references: await Promise.all(req.referenceImagePaths.map(async (p) => (await shrinkReference(p)).toString("base64"))) }),
    };
  }

  protected usdPerSec() {
    return this.deps.rates.keyframeUsdPerSec;
  }

  protected output(_jobId: string, out: { url: string; seed?: number }, costUsd: number | undefined): ImageOutput {
    return { url: out.url, seed: out.seed ?? -1, ...(costUsd === undefined ? {} : { costUsd }) };
  }
}

/** The one short side an LTX clip is made at (phase 15 spec §3); the long side is 1.8 times it, 1152. */
export const LTX_SHORT = 640;

/** The size an LTX clip is made at, upright or on its side like its picture. Any other short side is refused before a job is bought. */
export function ltxSize(short: number | undefined, portrait: boolean): { width: number; height: number } {
  const a = short ?? LTX_SHORT;
  if (a !== LTX_SHORT) throw new NonRetryableError(`an LTX clip is made with a short side of ${LTX_SHORT}, not ${a}`);
  const b = Math.round(a * 1.8);
  // (the worker's model takes sides in multiples of 64 only; 640 and 1152 are, and nothing else is ever sent)
  if (a % 64 !== 0 || b % 64 !== 0) throw new NonRetryableError(`an LTX clip's sides must be multiples of 64; got ${a}x${b}`);
  return portrait ? { width: a, height: b } : { width: b, height: a };
}

/**
 * Frames of an LTX clip of `durationSec`: the stage passes `frames / 24`, so a length that does not come back to 8k+1
 * frames between 49 and 361 is a mistake upstream and is refused here rather than rounded into a different clip.
 */
export function ltxClipFrames(durationSec: number): number {
  const frames = Math.round(durationSec * LTX_FPS);
  if (frames < LTX_MIN_FRAMES || frames > LTX_MAX_FRAMES || (frames - 1) % 8 !== 0) {
    throw new NonRetryableError(`an LTX clip must be 8k+1 frames between ${LTX_MIN_FRAMES} and ${LTX_MAX_FRAMES} at ${LTX_FPS} fps; got ${durationSec} s (${frames})`);
  }
  return frames;
}

/**
 * The words of an LTX clip's speech as the worker answered them: absent or null = not asked for (the clip was not
 * asked for speech); anything else must be a list of words with finite times, or the answer is unusable.
 */
function ltxWords(raw: unknown): WordTiming[] | undefined | "malformed" {
  if (raw === undefined || raw === null) return undefined;
  // (the same check a kept result is loaded with: the times become caption timings)
  const parsed = HeardWord.array().safeParse(raw);
  return parsed.success ? parsed.data : "malformed";
}

/**
 * Clips from the LTX worker (phase 15): 640x1152 at 24 fps, with the clip's own sound and, when asked, its speech's words.
 * It is the only clip worker: Wan's was removed on 2026-11-02 (§13.10), and a run made on it has a retired clip model.
 */
export class RunpodVideo extends RunpodQueued<VideoRequest, VideoOutput> implements VideoProvider {
  constructor(deps: RunpodDeps, target: Target) {
    // An LTX worker's first job after a cold start assembles about 68 GB of weights, and the longest clip measured took
    // about 300 s on top: twenty minutes to run and thirty to wait, so a clip that is still being paid for is not given up.
    super(deps, target, { executionTimeout: 1_200_000, ttl: 3_600_000 }, 30 * 60_000, "mp4");
  }

  // (a real LTX job was refused "unknown field workflow" on 2026-11-01: its worker makes one thing and is not told which)
  protected override withWorkflowKey(): boolean {
    return false;
  }

  protected async input(req: VideoRequest) {
    const png = await readFile(req.imagePath);
    const { width, height } = pngSize(png);
    const portrait = height >= width;
    // The scene's own seed, so a clip asked for again is the same clip; the worker requires one.
    if (req.seed === undefined || !Number.isSafeInteger(req.seed) || req.seed < 0) {
      throw new NonRetryableError(`an LTX clip needs a seed, a whole number from 0; got ${req.seed}`);
    }
    return {
      task: "clip",
      image: png.toString("base64"),
      prompt: req.prompt,
      frames: ltxClipFrames(req.durationSec),
      fps: LTX_FPS,
      ...ltxSize(req.height, portrait),
      seed: req.seed,
      ...(req.speechLanguage === undefined ? {} : { speech_language: req.speechLanguage }),
      // (only when asked: a worker image from before the voice check refuses a field it does not list)
      ...(req.detectVoice === true ? { detect_voice: true } : {}),
    };
  }

  protected usdPerSec() {
    return this.deps.rates.clipUsdPerSec;
  }

  protected output(jobId: string, out: { url: string }, costUsd: number | undefined, raw?: Record<string, unknown>): VideoOutput {
    const base = { url: out.url, ...(costUsd === undefined ? {} : { costUsd }) };
    // Recovered from the bucket (no answer to read): whether it has sound and what was said in it are unknown, and
    // are left undefined, never false or [], so a speaking scene cannot take "unknown" for "said nothing".
    if (raw === undefined) return { ...base, fps: LTX_FPS };
    const hasAudio = raw.has_audio;
    const words = ltxWords(raw.words);
    const voiceHeard = raw.voice_heard ?? undefined;
    // (the clip is paid for either way: a malformed answer is unusable at its cost, never free and never retried)
    if (
      (hasAudio !== undefined && typeof hasAudio !== "boolean") ||
      words === "malformed" ||
      (voiceHeard !== undefined && typeof voiceHeard !== "boolean")
    ) {
      throw new UnusableResultError(`RunPod job ${jobId} answered a malformed has_audio, words or voice_heard`, costUsd);
    }
    return {
      ...base,
      fps: LTX_FPS,
      ...(hasAudio === undefined ? {} : { hasAudio }),
      ...(words === undefined ? {} : { words }),
      ...(voiceHeard === undefined ? {} : { voiceHeard }),
    };
  }
}

/**
 * Clips upscaled to full HD by the SeedVR2 worker (phase 8 spec §8). The clip goes inside the request, as a picture
 * does: a 480p clip of a few seconds is one or two megabytes, well under what a request may carry.
 */
export class RunpodUpscale extends RunpodQueued<UpscaleRequest, VideoOutput> implements UpscaleProvider {
  constructor(deps: RunpodDeps, target: Target) {
    // (measured at about 200 GPU seconds for a 5-second clip: a quarter of an hour leaves room for a cold start)
    super(deps, target, { executionTimeout: 900_000, ttl: 3_600_000 }, 25 * 60_000, "mp4");
  }

  protected async input(req: UpscaleRequest) {
    return {
      task: "upscale",
      video: (await readFile(req.videoPath)).toString("base64"),
      ...(req.short === undefined ? {} : { short: req.short }),
      ...(req.interpolate === undefined ? {} : { interpolate: req.interpolate }),
    };
  }

  protected usdPerSec() {
    return this.deps.rates.upscaleUsdPerSec;
  }

  protected output(_jobId: string, out: { url: string }, costUsd: number | undefined): VideoOutput {
    return { url: out.url, ...(costUsd === undefined ? {} : { costUsd }) };
  }
}

/**
 * A scene's sound from the Foley worker (phase 14 spec §4). The small silent video of the scene goes inside the request
 * as a clip does; the answer is a wav in the bucket. Its rate is its own card's (`foleyRates`), so it is given here.
 */
export class RunpodFoley extends RunpodQueued<SoundRequest, SoundOutput> implements SoundProvider {
  constructor(
    deps: RunpodDeps,
    target: Target,
    private readonly rate: number,
  ) {
    // (a job is seconds of GPU on a warm worker; the wait covers a cold start that pulls a large image first)
    super(deps, target, { executionTimeout: 300_000, ttl: 3_600_000 }, 25 * 60_000, "wav");
  }

  protected async input(req: SoundRequest) {
    return {
      task: "sound",
      video: (await readFile(req.videoPath)).toString("base64"),
      prompt: req.prompt,
      negative_prompt: req.negativePrompt,
      seed: req.seed,
      guidance_scale: req.guidanceScale,
      steps: req.steps,
      audio_length: req.audioLengthSec,
    };
  }

  protected usdPerSec() {
    return this.rate;
  }

  protected output(_jobId: string, out: { url: string; seed?: number }, costUsd: number | undefined): SoundOutput {
    return { url: out.url, ...(out.seed === undefined ? {} : { seed: out.seed }), ...(costUsd === undefined ? {} : { costUsd }) };
  }
}
