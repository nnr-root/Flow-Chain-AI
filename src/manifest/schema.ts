import { z } from "zod";
import { Aspect } from "../config.js";
import { CaptionStyleName, Transition } from "../media/remotion/props.js";

export const MAX_NARRATION_WORDS = 22;
export const MAX_SCENES = 12;

export const StageName = z.enum(["script", "tts", "silence", "keyframes", "clips", "fit", "captions", "render"]);
export type StageName = z.infer<typeof StageName>;

export const Mode = z.union([z.literal(1), z.literal(2)]);
export type Mode = z.infer<typeof Mode>;

export const Camera = z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"]);
export type Camera = z.infer<typeof Camera>;

/** continue = same place and moment as the previous scene (its clip starts from the seam); cut = fresh keyframe. */
export const Shot = z.enum(["continue", "cut"]);
export type Shot = z.infer<typeof Shot>;

export const SceneSpec = z.object({
  narration: z.string().describe(`Voiceover for this scene, at most ${MAX_NARRATION_WORDS} words`),
  imagePrompt: z.string().describe("What one still frame of this scene shows"),
  motionPrompt: z.string().describe("Camera movement and subject motion during this scene"),
  shot: Shot.describe("continue = same place and moment as the previous scene; cut = new location, time or framing"),
  camera: Camera.describe("Camera move used if this scene is rendered from a still image"),
});
export type SceneSpec = z.infer<typeof SceneSpec>;

export const Script = z.object({
  title: z.string(),
  styleBible: z.object({
    artStyle: z.string(),
    characters: z.string(),
    palette: z.string(),
  }),
  scenes: z.array(SceneSpec).min(1).max(MAX_SCENES),
});
export type Script = z.infer<typeof Script>;

export const WordTiming = z.object({ text: z.string(), start: z.number(), end: z.number() });
export type WordTiming = z.infer<typeof WordTiming>;

export const StageRecord = z.object({
  status: z.enum(["done", "failed"]),
  inputHash: z.string(),
  costUsd: z.number(),
  finishedAt: z.string(),
  error: z.string().optional(),
});
export type StageRecord = z.infer<typeof StageRecord>;

export const FitPlan = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trim") }),
  z.object({ kind: z.literal("slow"), factor: z.number() }),
  z.object({ kind: z.literal("slow+freeze"), factor: z.literal(1.25), freezeSec: z.number() }),
]);
export type FitPlan = z.infer<typeof FitPlan>;

/**
 * A paid fal job (keyframes, clips) submitted for one inputHash. Saved before waiting, so a timeout, crash or
 * Ctrl-C resumes polling the same request instead of buying a new one. `result` is saved once the job
 * completes and is charged, so a failed download or post-processing step re-downloads instead of re-paying.
 */
export const ProviderJob = z.object({
  requestId: z.string(),
  inputHash: z.string(),
  submittedAt: z.string(),
  chargedUsd: z.number().default(0),
  result: z.object({ url: z.string(), seed: z.number().optional() }).optional(),
});
export type ProviderJob = z.infer<typeof ProviderJob>;

export const SceneState = z.object({
  idx: z.number().int(),
  mode: Mode,
  nonces: z.partialRecord(StageName, z.number().int()).default({}),
  stages: z.partialRecord(StageName, StageRecord).default({}),
  jobs: z.partialRecord(StageName, ProviderJob).default({}),
  tts: z.object({ raw: z.string(), words: z.array(WordTiming) }).optional(),
  audio: z
    .object({ path: z.string(), duration: z.number(), words: z.array(WordTiming), removedSec: z.number() })
    .optional(),
  keyframe: z.object({ path: z.string(), seed: z.number(), sourceUrl: z.string() }).optional(),
  clip: z
    .object({
      path: z.string(),
      sourceUrl: z.string().optional(),
      duration: z.number(),
      requestedSec: z.union([z.literal(5), z.literal(10)]).optional(),
    })
    .optional(),
  fitted: z.object({ path: z.string(), frames: z.number().int(), plan: FitPlan }).optional(),
});
export type SceneState = z.infer<typeof SceneState>;

/** How the final video looks; frozen per run and changed only by `rerender` (never paid work). */
export const RenderOptions = z.object({
  captionStyle: CaptionStyleName.default("hormozi"),
  transition: Transition.default("fade"),
  bgmGain: z.number().min(0).max(1).default(0.35),
});
export type RenderOptions = z.infer<typeof RenderOptions>;

export const RunRequest = z.object({
  topic: z.string().min(1),
  aspect: Aspect,
  sceneCount: z.number().int().min(1).max(MAX_SCENES),
  modes: z.array(Mode),
  /** Fixed shot per scene (testing override from --shots); when absent the LLM decides. */
  shots: z.array(Shot).optional(),
  voiceId: z.string().min(1),
  bgm: z.string().optional(),
  render: RenderOptions.default({ captionStyle: "hormozi", transition: "fade", bgmGain: 0.35 }),
});
export type RunRequest = z.infer<typeof RunRequest>;

export const Models = z.object({ llm: z.string(), tts: z.string(), image: z.string(), video: z.string() });
export type Models = z.infer<typeof Models>;

export const LedgerEntry = z.object({
  stage: StageName,
  scene: z.number().int().optional(),
  usd: z.number(),
  at: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const SCHEMA_VERSION = 2;

export const Manifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string(),
  createdAt: z.string(),
  request: RunRequest,
  models: Models,
  script: Script.optional(),
  runStages: z.partialRecord(StageName, StageRecord).default({}),
  scenes: z.array(SceneState),
  final: z.object({ path: z.string(), duration: z.number(), chain: z.string() }).optional(),
  ledger: z.array(LedgerEntry).default([]),
});
export type Manifest = z.infer<typeof Manifest>;
