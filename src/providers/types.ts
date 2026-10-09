import type { Aspect } from "../config.js";
import type { Shot, WordTiming } from "../manifest/schema.js";
import type { PresetName } from "../presets.js";

export type ScriptRequest = {
  topic: string;
  sceneCount: number;
  aspect: Aspect;
  shots?: Shot[];
  /** Forced style preset; absent = the LLM picks one. */
  style?: PresetName;
  /** Fixed character bible; absent = the LLM describes the characters. */
  characters?: string;
  feedback?: string;
};
export interface LlmProvider {
  /** Returns parsed JSON; the script stage validates it against the LlmScript schema. */
  generateScript(req: ScriptRequest): Promise<unknown>;
}

/** `language`: the script's, where it is known (the studio's own voice picks its reference clip by it). */
export type SpeakRequest = { text: string; previousText?: string; nextText?: string; voiceId: string; language?: string };
export interface TtsProvider {
  /** `audio` is MP3 bytes; `words` are relative to the start of that audio. `costUsd`: what it really cost, where the provider bills by measured time. */
  speak(req: SpeakRequest): Promise<{ audio: Buffer; words: WordTiming[]; costUsd?: number }>;
}

export type WaitOptions = { timeoutMs: number };
export type SubmitOptions = { signal: AbortSignal };

/** The provider's request body, built by `prepare` (any uploads already done). */
export type PreparedJob = { readonly input: Record<string, unknown> };

/**
 * A paid provider that works through a job queue.
 * - `prepare` does the free work (e.g. uploading the input image) and is safe to repeat.
 * - `submit` buys exactly one job and returns its request id without waiting. Aborting `signal` cancels the
 *   HTTP request so a slow submit can be abandoned without completing (and billing) later.
 * - `wait` polls that id (safe to repeat, never buys anything) until the job completes, then returns its
 *   output. It throws UnusableResultError when the job completed (so it was billed) but its output cannot be
 *   used, and NonRetryableError when the job is still not finished after `timeoutMs`.
 */
export interface QueuedProvider<Req, Out> {
  /** How long one wait may take, when the provider needs longer than the stage default (e.g. cold starts). */
  readonly waitMs?: number;
  /** How long the submit request may take, when it carries more than the stage default allows (e.g. an image inside it). */
  readonly submitMs?: number;
  prepare(req: Req): Promise<PreparedJob>;
  submit(job: PreparedJob, opts: SubmitOptions): Promise<string>;
  wait(requestId: string, opts: WaitOptions): Promise<Out>;
}

export type ImageRequest = {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  /** The run's style preset (providers that pick a model per preset). */
  preset?: PresetName;
  /** A character portrait to condition the image on (providers that support references). */
  referenceImagePath?: string;
};
/** `costUsd`: what the job actually cost, when the provider bills by measured time (else the stage estimate). */
/**
 * `remove`: takes the output away from where the provider left it, once the pipeline has its own copy (phase 5
 * spec §8): a customer's picture or clip is not to lie in a bucket longer than the minutes it is needed there.
 */
export type ImageOutput = { url: string; seed: number; costUsd?: number; remove?: () => Promise<void> };
export type ImageProvider = QueuedProvider<ImageRequest, ImageOutput>;

export type VideoRequest = { imagePath: string; prompt: string; durationSec: number };
export type VideoOutput = { url: string; costUsd?: number; remove?: () => Promise<void> };
export type VideoProvider = QueuedProvider<VideoRequest, VideoOutput>;

export type Providers = { llm: LlmProvider; tts: TtsProvider; image: ImageProvider; video: VideoProvider };
