import type { Aspect } from "../config.js";
import type { WordTiming } from "../manifest/schema.js";

export type ScriptRequest = { topic: string; sceneCount: number; aspect: Aspect; feedback?: string };
export interface LlmProvider {
  /** Returns parsed JSON; the script stage validates it against the Script schema. */
  generateScript(req: ScriptRequest): Promise<unknown>;
}

export type SpeakRequest = { text: string; previousText?: string; nextText?: string; voiceId: string };
export interface TtsProvider {
  /** `audio` is MP3 bytes; `words` are relative to the start of that audio. */
  speak(req: SpeakRequest): Promise<{ audio: Buffer; words: WordTiming[] }>;
}

export type ImageRequest = { prompt: string; width: number; height: number; seed?: number };
export interface ImageProvider {
  generate(req: ImageRequest): Promise<{ url: string; seed: number }>;
}

export type VideoRequest = { imagePath: string; prompt: string; durationSec: 5 | 10 };
export interface VideoProvider {
  imageToVideo(req: VideoRequest): Promise<{ url: string }>;
}

export type Providers = { llm: LlmProvider; tts: TtsProvider; image: ImageProvider; video: VideoProvider };
