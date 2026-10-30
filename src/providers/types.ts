import type { Aspect } from "../config.js";
import type { Timing } from "../duration.js";
import type { SpeechLanguage } from "../voice/language.js";
import type { LlmOutline, Shot, StoredOutline, WordTiming } from "../manifest/schema.js";
import type { PresetName } from "../presets.js";
import type { ChartItem } from "../trends/chart.js";

export type ScriptRequest = {
  topic: string;
  sceneCount: number;
  aspect: Aspect;
  shots?: Shot[];
  /** Forced style preset; absent = the LLM picks one. */
  style?: PresetName;
  /** Fixed character bible; absent = the LLM describes the characters. */
  characters?: string;
  /** The voice that will say it, where it speaks slower or faster than the narrators (fewer or more words). */
  voiceId?: string;
  /** The words a second the script is asked for, as the run froze it; absent = worked out from the language and voice. */
  wordsPerSecond?: number;
  /** The kind of video (phase 7 spec §19): a niche the studio knows, or one the user wrote. */
  niche?: string;
  nicheText?: string;
  /** The type of video (phase 8 spec §2): how it is told, whatever its niche. */
  format?: string;
  /** How it moves and is cut (phase 8 spec §3): the script frames and cuts its scenes for it. */
  edit?: string;
  /** Made for the audience of its one language (phase 8 spec §5): who is in it where the topic leaves it open. */
  localize?: boolean;
  /** The script may mark a cut as a reframe (phase 10 spec §4); absent = it may not and is not told of it. */
  reframe?: boolean;
  /** The language to write what is said and shown as words in; absent = the model's own choice. */
  language?: SpeechLanguage;
  feedback?: string;
  /**
   * The video was asked for by its length: the answer keeps to these seconds (as words) and decides the number
   * of scenes itself. Absent = exactly `sceneCount` scenes.
   */
  timing?: Timing;
  /**
   * A long video is written in parts (phase 7 spec §4). `outline`: what the parts share and what each tells,
   * answered as an `LlmOutline`. `part`: one part's scenes, answered as an `LlmPart`; `previous` are the last
   * lines of the part before it. Absent = the whole script in one answer (`LlmScript`).
   */
  ask?:
    | { kind: "outline"; partSec: number[] }
    | { kind: "part"; index: number; partSec: number[]; outline: StoredOutline; previous: string[] }
    /**
     * A version in another language (phase 8 spec §4): what the source says, scene by scene, and the seconds each
     * scene's pictures were made for; answered as an `LlmTranslation` in `language`. `from`: the source's language.
     */
    | { kind: "translate"; source: { title: string; hook: string; narrations: string[] }; seconds: number[]; from?: SpeechLanguage };
};
/** Pictures to look at before they are used (phase 8 spec §9): what they should show, and the files. */
export type InspectRequest = { images: string[]; expected: string; references?: string[]; checkContent?: boolean };

/** What the topic-ideas call is given (phase 13 spec §2): the chart is data for the prompt, not instructions. */
export type IdeasRequest = { niche?: string; nicheText?: string; format?: string; language: string; region: string; chart: ChartItem[]; today: string };
/** What it gives back: the model's text, the hosts its search visited (the only hosts a source may name), and what it used. */
export type IdeasAnswer = { text: string; hosts: string[]; usage?: { inputTokens?: number; outputTokens?: number; searches?: number } };

export interface LlmProvider {
  /** Which prompts this provider writes with (phase 9 spec §4); recorded with the script, never hashed. */
  readonly promptVersion?: string;
  /** Returns parsed JSON; the script stage validates it against the LlmScript schema. */
  generateScript(req: ScriptRequest): Promise<unknown>;
  /** Looks at pictures for what a picture model gets wrong; parsed JSON `{ ok, problems }`. Optional: without it nothing is looked at. */
  inspect?(req: InspectRequest): Promise<unknown>;
  /** Expands a picture prompt for a model that needs it, seeing its reference pictures (phase 10 spec §3). Optional: a provider without it leaves the prompt as it is. */
  upsample?(req: { prompt: string; images?: string[] }): Promise<string>;
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
  /** Several reference pictures, in order (phase 10 spec §5): portrait, look anchor, previous picture. Only a profile that takes several reads this. */
  referenceImagePaths?: string[];
};
/** `costUsd`: what the job actually cost, when the provider bills by measured time (else the stage estimate). */
/**
 * `remove`: takes the output away from where the provider left it, once the pipeline has its own copy (phase 5
 * spec §8): a customer's picture or clip is not to lie in a bucket longer than the minutes it is needed there.
 */
export type ImageOutput = { url: string; seed: number; costUsd?: number; remove?: () => Promise<void> };
export type ImageProvider = QueuedProvider<ImageRequest, ImageOutput>;

/** `height`: the short side clips are generated at (480 or 720), where the run chooses; absent = the provider's own. */
export type VideoRequest = { imagePath: string; prompt: string; durationSec: number; height?: number };
export type VideoOutput = { url: string; costUsd?: number; remove?: () => Promise<void> };
export type VideoProvider = QueuedProvider<VideoRequest, VideoOutput> & {
  /**
   * Starts the provider's worker ahead of the first clip and returns the request's id without waiting. It buys
   * GPU seconds (the ones the first clip would otherwise wait and pay for), so its caller records it first.
   */
  warm?(opts: SubmitOptions): Promise<string>;
  /** What that start cost, once it is over. Read-only and safe to repeat; throws when it cannot be known. */
  warmCost?(requestId: string, opts: WaitOptions): Promise<number>;
};

/** A clip to upscale (phase 8 spec §8): the file, and the height of the short side to make it. */
export type UpscaleRequest = { videoPath: string; short?: number; interpolate?: 2 };
export type UpscaleProvider = QueuedProvider<UpscaleRequest, VideoOutput>;

/** `upscale`: only for a run that asked for full HD. */
export type Providers = { llm: LlmProvider; tts: TtsProvider; image: ImageProvider; video: VideoProvider; upscale?: UpscaleProvider };
