import { z } from "zod";
import { BrandLook } from "../brand.js";
import { Aspect, Prices } from "../config.js";
import { CaptionStyleName, Transition } from "../media/remotion/props.js";
import { PresetName } from "../presets.js";
import { ImageProfileId } from "../image-profiles.js";
import { VideoProfileId } from "../video-profiles.js";

export const MAX_NARRATION_WORDS = 16;
export const MAX_SCENES = 12;
export const MAX_HOOK_WORDS = 6;
// fal's Flux seed is a signed 32-bit integer; every seed it has returned is below 2^31.
export const MAX_SEED = 2 ** 31 - 1;

export const StageName = z.enum(["script", "reference", "tts", "silence", "modes", "keyframes", "clips", "fit", "captions", "render"]);
export type StageName = z.infer<typeof StageName>;

export const Mode = z.union([z.literal(1), z.literal(2)]);
export type Mode = z.infer<typeof Mode>;

export const Camera = z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"]);
export type Camera = z.infer<typeof Camera>;

/** continue = same place and moment as the previous scene (its clip starts from the seam); cut = fresh keyframe. */
export const Shot = z.enum(["continue", "cut"]);
export type Shot = z.infer<typeof Shot>;

/** How much on-screen motion a scene has: high is worth real video (Mode 1), low is a still (Mode 2). */
export const ActionLevel = z.enum(["high", "medium", "low"]);
export type ActionLevel = z.infer<typeof ActionLevel>;

/** How the cut into a scene should feel (Gemini's vocabulary; `zoom_transition` renders as `zoom`). */
export const SuggestedTransition = z.enum(["cut", "fade", "dissolve", "zoom_transition"]);
export type SuggestedTransition = z.infer<typeof SuggestedTransition>;

const actionLevel = ActionLevel.describe(
  "high = fast or complex motion worth real video; medium = some motion; low = still, contemplative or text-like",
);
const suggestedTransition = SuggestedTransition.describe(
  "How the cut into this scene should feel: cut = punchy, fade/dissolve = time passing or mood shift, zoom_transition = energetic jump",
);

export const SceneSpec = z.object({
  narration: z.string().describe(`Voiceover for this scene, at most ${MAX_NARRATION_WORDS} words`),
  imagePrompt: z.string().describe("What one still frame of this scene shows"),
  motionPrompt: z.string().describe("Camera movement and subject motion during this scene"),
  shot: Shot.describe("continue = same place and moment as the previous scene; cut = new location, time or framing"),
  camera: Camera.describe("Camera move used if this scene is rendered from a still image"),
  /** Optional when stored, so scripts written before 2.2 still load; Gemini must always send it (LlmSceneSpec). */
  actionLevel: actionLevel.optional(),
  suggestedTransition: suggestedTransition.optional(),
});
export type SceneSpec = z.infer<typeof SceneSpec>;

export const Script = z.object({
  title: z.string(),
  /** Before styleBible, so Gemini (which answers in schema order) settles the look before writing any prompt. */
  stylePreset: PresetName.optional(),
  styleBible: z.object({
    artStyle: z.string(),
    characters: z.string(),
    palette: z.string(),
  }),
  scenes: z.array(SceneSpec).min(1).max(MAX_SCENES),
  /** The hook title (2.3); optional when stored, so scripts written before 2.3 still load. */
  hook: z.string().optional(),
});
export type Script = z.infer<typeof Script>;

/** Gemini's answer (sent as the response schema): the 2.2 fields are required. */
export const LlmSceneSpec = SceneSpec.extend({ actionLevel, suggestedTransition });
export const LlmScript = Script.extend({
  stylePreset: PresetName.describe("The style preset that best fits the topic"),
  scenes: z.array(LlmSceneSpec).min(1).max(MAX_SCENES),
  hook: z
    .string()
    .describe("2-6 punchy words shown as a big title in the first 3 seconds; tease the payoff without giving it away"),
});
export type LlmScript = z.infer<typeof LlmScript>;

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
  /**
   * What the job will cost when it completes, recorded at submit. A job that was submitted and never waited for
   * (the run was stopped, the process killed) is still billed by the provider: whoever accounts for a run's
   * spend from outside can count it from here until `chargedUsd` takes its place. Absent on older runs.
   */
  expectedUsd: z.number().optional(),
  chargedUsd: z.number().default(0),
  result: z.object({ url: z.string(), seed: z.number().optional() }).optional(),
});
export type ProviderJob = z.infer<typeof ProviderJob>;

export const SceneState = z.object({
  idx: z.number().int(),
  mode: Mode,
  /** Why the scene has its mode (written by the modes stage, shown by status). */
  modeReason: z.string().optional(),
  nonces: z.partialRecord(StageName, z.number().int()).default({}),
  stages: z.partialRecord(StageName, StageRecord).default({}),
  jobs: z.partialRecord(StageName, ProviderJob).default({}),
  /**
   * The expected cost of provider jobs that were submitted for this scene and then given up for a new one
   * before they were collected (a reroll while a job was in flight). The provider bills them all the same, and
   * their records are gone from `jobs`, so their cost is kept here. Absent on older runs and on most scenes.
   */
  abandonedUsd: z.number().optional(),
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
      /** Seconds of video bought (from the run's video profile). */
      requestedSec: z.number().positive().optional(),
    })
    .optional(),
  fitted: z.object({ path: z.string(), frames: z.number().int(), plan: FitPlan }).optional(),
});
export type SceneState = z.infer<typeof SceneState>;

/** How the final video looks; frozen per run and changed only by `rerender` (never paid work). */
export const RenderOptions = z.object({
  /** "preset" = the effective style preset's caption look (hormozi when there is none). */
  captionStyle: z.union([CaptionStyleName, z.literal("preset")]).default("preset"),
  /** "auto" = each cut uses the incoming scene's suggestedTransition (fade when it has none). */
  transition: z.union([Transition, z.literal("auto")]).default("auto"),
  bgmGain: z.number().min(0).max(1).default(0.35),
  /** Show the hook (title, snap zoom, impact) when there is hook text. */
  hook: z.boolean().default(true),
  /** Replaces the script's hook text. */
  hookText: z.string().trim().min(1).max(60).optional(),
  /** Sound effects at the hook and at cuts. */
  sfx: z.boolean().default(true),
  /** Sound-effect level relative to the narration. */
  sfxGain: z.number().min(0).max(1).default(0.6),
  /** The brand kit's look (watermark, font, colours), copied into the run; absent = no brand. */
  brand: BrandLook.optional(),
});
export type RenderOptions = z.infer<typeof RenderOptions>;

export const RunRequest = z.object({
  topic: z.string().min(1),
  aspect: Aspect,
  sceneCount: z.number().int().min(1).max(MAX_SCENES),
  /** Absent = auto: the modes stage picks each scene's mode from its action level and modeBudgetUsd. */
  modes: z.array(Mode).optional(),
  /** Frozen budget for the auto mode rules (required when modes is absent). */
  modeBudgetUsd: z.number().min(0).optional(),
  /** Frozen price table for the auto mode rules (required when modes is absent). */
  modePrices: Prices.optional(),
  /**
   * Per-scene modes pinned on a draft of an auto run (3.1): null leaves the scene to the mode rules. Absent on
   * runs made by the CLI or before 3.1; changeable only until media is bought (`draft-modes`).
   */
  modeOverrides: z.array(Mode.nullable()).optional(),
  /** Forced style preset (--style); absent = Gemini picks one. */
  style: PresetName.optional(),
  /** Character bible (--characters or the brand kit's), enforced into styleBible.characters; frozen. */
  characters: z.string().trim().min(1).max(600).optional(),
  /** Flux seed shared by every keyframe of the run (plus the scene's reroll count); frozen. */
  seed: z.number().int().min(0).max(MAX_SEED).optional(),
  /** How clips are bought (clip length per narration, price); absent = kling-v1 (runs made before 2.3); frozen. */
  videoProfile: VideoProfileId.optional(),
  /** How keyframes are bought; absent = fal-flux@1 (runs made before 2.4); frozen. */
  imageProfile: ImageProfileId.optional(),
  /** A brand kit's character portrait, copied into the run (run-relative path); frozen. */
  referenceImage: z.string().optional(),
  /** Fixed shot per scene (testing override from --shots); when absent the LLM decides. */
  shots: z.array(Shot).optional(),
  voiceId: z.string().min(1),
  bgm: z.string().optional(),
  render: RenderOptions.default({ captionStyle: "preset", transition: "auto", bgmGain: 0.35, hook: true, sfx: true, sfxGain: 0.6 }),
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
  /**
   * Provider calls that are paid for on their answer (narration, the script) and are on their way right now,
   * by "stage" or "stage:scene", with what each is expected to cost. Only ever non-empty in a manifest whose
   * process was ended mid-call; see `withExpectedSpend`. Absent on older runs.
   */
  inFlight: z.record(z.string(), z.number()).optional(),
  /** What such calls cost that were found left over and made again: billed by the provider, in no ledger entry. */
  abandonedUsd: z.number().optional(),
});
export type Manifest = z.infer<typeof Manifest>;
