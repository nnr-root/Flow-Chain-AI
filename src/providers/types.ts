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
  feedback?: string;
};
export interface LlmProvider {
  /** Returns parsed JSON; the script stage validates it against the LlmScript schema. */
  generateScript(req: ScriptRequest): Promise<unknown>;
}

export type SpeakRequest = { text: string; previousText?: string; nextText?: string; voiceId: string };
export interface TtsProvider {
  /** `audio` is MP3 bytes; `words` are relative to the start of that audio. */
  speak(req: SpeakRequest): Promise<{ audio: Buffer; words: WordTiming[] }>;
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
  prepare(req: Req): Promise<PreparedJob>;
  submit(job: PreparedJob, opts: SubmitOptions): Promise<string>;
  wait(requestId: string, opts: WaitOptions): Promise<Out>;
}

export type ImageRequest = { prompt: string; width: number; height: number; seed?: number };
export type ImageOutput = { url: string; seed: number };
export type ImageProvider = QueuedProvider<ImageRequest, ImageOutput>;

export type VideoRequest = { imagePath: string; prompt: string; durationSec: 5 | 10 };
export type VideoOutput = { url: string };
export type VideoProvider = QueuedProvider<VideoRequest, VideoOutput>;

export type Providers = { llm: LlmProvider; tts: TtsProvider; image: ImageProvider; video: VideoProvider };
