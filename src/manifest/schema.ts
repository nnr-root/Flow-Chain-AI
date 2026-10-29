import { z } from "zod";
import { SCENE_SOUNDS } from "../sounds.js";
import { BrandLook } from "../brand.js";
import { Aspect, Prices } from "../config.js";
import { CaptionStyleName, Transition } from "../media/remotion/props.js";
import { PresetName } from "../presets.js";
import { ImageProfileId } from "../image-profiles.js";
import { NICHE_IDS, NICHE_TEXT_MAX } from "../niches.js";
import { FORMAT_IDS } from "../formats.js";
import { EDIT_IDS } from "../edits.js";
import { SPEECH_LANGUAGE_CODES } from "../voice/language.js";
import { VideoProfileId } from "../video-profiles.js";

export const MAX_NARRATION_WORDS = 16;
/**
 * The most scenes a run can have: ten minutes of the shortest scene a clip can be (phase 7 spec; `VIDEO_SECONDS`,
 * `SCENE_SECONDS`). A run asked for by a number of scenes is held to `MAX_COUNTED_SCENES`, as it always was.
 */
export const MAX_SCENES = 360;
/** The most scenes of a run that is asked for by their number: one answer of the script's model. */
export const MAX_COUNTED_SCENES = 12;
export const MAX_HOOK_WORDS = 6;
// fal's Flux seed is a signed 32-bit integer; every seed it has returned is below 2^31.
export const MAX_SEED = 2 ** 31 - 1;

export const StageName = z.enum(["script", "reference", "tts", "silence", "modes", "keyframes", "clips", "upscale", "interpolate", "fit", "captions", "render"]);
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
const showsCharacter = z
  .boolean()
  .describe("true when a recurring character from styleBible.characters is visible in this scene's frame; false for a place, an object or a detail without them");
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
  /** Optional when stored: absent means false. A cut to the same place and moment as the previous scene, from a new view (phase 10 spec §4). */
  reframe: z.boolean().optional().describe("true on a cut scene that shows the same place and moment as the previous scene from a new angle or distance; false otherwise"),
  /** Optional when stored: a script written before phase 5 says nothing, and is read as it always was (in every scene). */
  showsCharacter: showsCharacter.optional(),
  /** Optional when stored: absent means none. Sounds the scene would have, from a closed library (phase 12 spec §2). */
  soundCues: z
    .array(z.object({ sound: z.enum(SCENE_SOUNDS), at: z.enum(["start", "middle", "end"]) }))
    .max(2)
    .optional()
    .describe("Up to 2 sounds this scene would clearly have, each with where it plays; leave empty or omit when unsure"),
});
export type SceneSpec = z.infer<typeof SceneSpec>;
export type SceneSoundCue = NonNullable<SceneSpec["soundCues"]>[number];

export const Script = z.object({
  title: z.string(),
  /** Before styleBible, so Gemini (which answers in schema order) settles the look before writing any prompt. */
  stylePreset: PresetName.optional(),
  styleBible: z.object({
    artStyle: z.string(),
    characters: z.string(),
    palette: z.string(),
    /**
     * The one time and place the video is set in, with what is worn, used and lit there (phase 7 spec §21): added to
     * every picture and clip, so none shows a suit in 1453. Absent on scripts written before it, which are prompted
     * as they were.
     */
    setting: z.string().optional(),
    /**
     * What the recurring characters are (phase 8 spec §9): "people", "animal" (a real kind of animal) or "other" (a
     * made-up figure, a creature, a robot), or "none". A portrait is drawn for people and made-up figures only, and
     * never in a person's words for anything else: asked for "arms relaxed at the sides" a falcon was given hands.
     * Absent on scripts written before it, which are drawn as they were.
     */
    characterKind: z.enum(["people", "animal", "other", "none"]).optional(),
  }),
  scenes: z.array(SceneSpec).min(1).max(MAX_SCENES),
  /** The hook title (2.3); optional when stored, so scripts written before 2.3 still load. */
  hook: z.string().optional(),
  /** Five hashtags to post it with, in its language (phase 7 spec §18); absent on scripts written before them. */
  hashtags: z.array(z.string()).optional(),
});
export type Script = z.infer<typeof Script>;

const hashtags = z
  .array(z.string())
  .min(1)
  .max(10)
  .describe("Exactly 5 hashtags to post the video with, each starting with #, in the video's language");

/** Gemini's answer (sent as the response schema): the fields added since are required. */
export const LlmSceneSpec = SceneSpec.extend({ actionLevel, suggestedTransition, showsCharacter });
const LlmStyleBible = Script.shape.styleBible.extend({
  setting: z.string().describe("The one time and place every picture shows, with what people there wear and use and how it is lit, in English"),
  characterKind: z.enum(["people", "animal", "other", "none"]).describe("What the recurring characters are: people, a real kind of animal, something else (a made-up creature, a robot, a figure), or none"),
});
export const LlmScript = Script.extend({
  stylePreset: PresetName.describe("The style preset that best fits the topic"),
  styleBible: LlmStyleBible,
  scenes: z.array(LlmSceneSpec).min(1).max(MAX_SCENES),
  hook: z
    .string()
    .describe("2-6 punchy words shown as a big title in the first 3 seconds; tease the payoff without giving it away"),
  hashtags,
});
export type LlmScript = z.infer<typeof LlmScript>;

/**
 * A long video's script is written in parts (phase 7 spec §4): first what every part has in common and what each
 * tells, then each part's scenes. These are those two answers.
 */
export const LlmOutline = z.object({
  title: z.string(),
  stylePreset: PresetName.describe("The style preset that best fits the topic"),
  styleBible: LlmStyleBible,
  hook: LlmScript.shape.hook,
  parts: z.array(z.object({ summary: z.string().describe("What this part of the video tells, in one or two sentences") })).min(1).max(20),
  // (last: the model answers in this order, and tags a video best once it has said what the video tells)
  hashtags,
});
export type LlmOutline = z.infer<typeof LlmOutline>;
/** An outline as a run keeps it: one kept before hashtags were asked for has none, and still loads. */
export const StoredOutline = LlmOutline.extend({ styleBible: Script.shape.styleBible, hashtags: LlmOutline.shape.hashtags.optional() });
export type StoredOutline = z.infer<typeof StoredOutline>;
export const LlmPart = z.object({ scenes: z.array(LlmSceneSpec).min(1).max(60) });
export type LlmPart = z.infer<typeof LlmPart>;

/** A version's translation (phase 8 spec §4): what is said in the video, scene by scene, in its new language. */
export const LlmTranslation = z.object({
  title: z.string().min(1),
  hook: LlmScript.shape.hook,
  narrations: z.array(z.string().min(1).describe("What this scene says, in the new language")).min(1).max(MAX_SCENES),
  // (last, as in a script: a video is tagged best once what it says has been written)
  hashtags,
});
export type LlmTranslation = z.infer<typeof LlmTranslation>;

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
  /**
   * How many times a picture or clip was made again because the look at it found it malformed (phase 8 spec §9),
   * for the inputs it was made for: a stopped run carries on from there instead of buying the first one again.
   */
  remade: z.partialRecord(StageName, z.object({ inputHash: z.string(), count: z.number().int().min(1) })).optional(),
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
  /** The clip upscaled to full HD (phase 8 spec §8): what the fit plays where the run asked for it. */
  upscaled: z.object({ path: z.string(), sourceUrl: z.string().optional(), duration: z.number() }).optional(),
  /** The clip interpolated to twice its frame rate (phase 11 spec §4): what the fit plays in a 60 fps run that is not in full HD. */
  smoothed: z.object({ path: z.string(), sourceUrl: z.string().optional(), duration: z.number() }).optional(),
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
  /**
   * How many scenes. On a run asked for by its length (`timing`) this is what was assumed until the script was
   * written, and what the script has from then on.
   */
  sceneCount: z.number().int().min(1).max(MAX_SCENES),
  /**
   * The run was asked for by its length (phase 7 spec): about how long the whole video runs and how long each
   * scene may stay, in seconds. The script's model then decides how many scenes there are. Absent on a run asked
   * for by a number of scenes (the CLI's `--scenes`, and every run made before); frozen.
   */
  timing: z.object({
    targetSec: z.number().positive().max(600),
    sceneSec: z.object({ min: z.number().positive(), max: z.number().positive() }),
  }).optional(),
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
  /**
   * The language the video is told in (--language): the script is written in it and the voice speaks from its
   * clip in it. Absent = whatever the script's model wrote, worked out from the script afterwards; frozen.
   */
  language: z.enum(SPEECH_LANGUAGE_CODES).optional(),
  /** Forced style preset (--style); absent = Gemini picks one. */
  style: PresetName.optional(),
  /**
   * The kind of video it is (phase 7 spec §19): one of the niches the studio knows (--niche), or one the user
   * wrote (--niche-text). The script is written as videos in it are. Absent on every run made before.
   */
  niche: z.enum(NICHE_IDS).optional(),
  /**
   * The words a second its script is asked for (phase 7 spec §20): frozen when the run is made, from its language and
   * voice, so that a measurement made later does not change a script already bought. Absent on earlier runs, which
   * work it out from the code as they always did.
   */
  wordsPerSecond: z.number().positive().max(20).optional(),
  /** How its lines' silence is trimmed (phase 7 spec §22): 2 since 2026-10-15; absent on every run made before, trimmed as they were. */
  silence: z.literal(2).optional(),
  nicheText: z.string().trim().min(1).max(NICHE_TEXT_MAX).regex(/^[^\n\r]*$/).optional(),
  /** The type of video (--format, phase 8 spec §2): how it is told. Absent on every run made before, and on one left to its niche. */
  format: z.enum(FORMAT_IDS).optional(),
  /**
   * How it moves and is cut (--edit, phase 8 spec §3): the script frames for it, every picture and clip is asked for
   * with its words, and the render cuts and finishes the frame its way. Absent = as every run made before.
   */
  edit: z.enum(EDIT_IDS).optional(),
  /**
   * Made for the audience of its one language (phase 8 spec §5): frozen when the run is made, true for a video in one
   * language other than English, false for one that will be made in other languages too or that was asked not to.
   * Absent on every run made before, which was not.
   */
  localize: z.boolean().optional(),
  /** Full HD (--upscale, phase 8 spec §8): every clip is upscaled to 1080p before it is fitted. Frozen; absent = as made. */
  upscale: z.literal(true).optional(),
  /** Smooth motion (--fps 60, phase 11 spec §2): the run is made and rendered at 60 frames a second. Frozen; absent = 30. */
  fps: z.literal(60).optional(),
  /**
   * The run is a version of another in a new language (phase 8 spec §4): its pictures and clips are that run's, and
   * what is said in it is a translation of what was said there (`title`, `hook`, `narrations`), each scene written to
   * be spoken in about the seconds its pictures were made for (`seconds`). Absent on every other run.
   */
  versionOf: z.object({
    runId: z.string().min(1),
    language: z.enum(SPEECH_LANGUAGE_CODES).optional(),
    title: z.string(),
    hook: z.string(),
    narrations: z.array(z.string()).min(1),
    seconds: z.array(z.number().positive()).min(1),
  }).optional(),
  /** Character bible (--characters or the brand kit's), enforced into styleBible.characters; frozen. */
  characters: z.string().trim().min(1).max(600).optional(),
  /** Flux seed shared by every keyframe of the run (plus the scene's reroll count); frozen. */
  seed: z.number().int().min(0).max(MAX_SEED).optional(),
  /** How clips are bought (clip length per narration, price); absent = kling-v1 (runs made before 2.3); frozen. */
  videoProfile: VideoProfileId.optional(),
  /** How keyframes are bought; absent = fal-flux@1 (runs made before 2.4); frozen. */
  imageProfile: ImageProfileId.optional(),
  /** Reframe cuts and the shared look reference are in use (phase 10 spec §5); frozen at the start, absent = no; set only on a profile that takes several references. */
  cutReferences: z.boolean().optional(),
  /** A brand kit's character portrait, copied into the run (run-relative path); frozen. */
  referenceImage: z.string().optional(),
  /** Fixed shot per scene (testing override from --shots); when absent the LLM decides. */
  shots: z.array(Shot).optional(),
  voiceId: z.string().min(1),
  bgm: z.string().optional(),
  render: RenderOptions.default({ captionStyle: "preset", transition: "auto", bgmGain: 0.35, hook: true, sfx: true, sfxGain: 0.6 }),
});
export type RunRequest = z.infer<typeof RunRequest>;

/** `upscale`: the restorer endpoint (phase 8 spec §8; phase 11: it also interpolates) a run that asked for full HD or 60 fps has its clips made on; absent on every other run. */
export const Models = z.object({ llm: z.string(), tts: z.string(), image: z.string(), video: z.string(), upscale: z.string().optional() });
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
  /**
   * The clip worker's early start, asked for while the pictures are made (phase 5 spec §9.15): its request, until
   * the first clip has settled what it cost. Its expected cost is in `inFlight` for as long as this is here.
   */
  warmup: z.object({ requestId: z.string(), submittedAt: z.string() }).optional(),
  /**
   * A script that is being written in parts: the answers that were bought and accepted so far, for the inputs
   * `inputHash` stands for. Each is saved with its charge, so continuing a stopped run buys none of them again.
   * Gone once the script is whole.
   */
  scriptParts: z.object({ inputHash: z.string(), outline: StoredOutline.optional(), parts: z.array(LlmPart.shape.scenes) }).optional(),
  /** Which prompt version wrote the script (phase 9 spec §4). Diagnostic only, and in no input hash. Absent on older runs. */
  scriptPromptVersion: z.string().optional(),
});
export type Manifest = z.infer<typeof Manifest>;
