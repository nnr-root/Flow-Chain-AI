import { join } from "node:path";
import { loadBrandKit } from "@src/brand";
import { Aspect } from "@src/config";
import { NICHE_IDS, NICHE_TEXT_MAX, nicheById } from "@src/niches";
import { FORMAT_IDS, formatClash } from "@src/formats";
import { EDIT_IDS } from "@src/edits";
import { SPEECH_LANGUAGE_CODES, type VoiceId, VOICES } from "@src/voice/language";
import { DEFAULT_SCENE_SECONDS, DEFAULT_VIDEO_SECONDS, SCENE_SECONDS, VIDEO_SECONDS } from "@src/duration";
import { MAX_SCENES, MAX_SEED, Mode } from "@src/manifest/schema";
import { CaptionStyleName, Transition } from "@src/media/remotion/props";
import { PresetName } from "@src/presets";
import { REROLLABLE } from "@src/reroll";
import type { LookFlags } from "@src/studio/props";
import { z } from "zod";
import { roots } from "./config";
import { ApiError } from "./http";

export const NicheChoice = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("known"), id: z.enum(NICHE_IDS) }),
    z.object({ kind: z.literal("custom"), text: z.string().trim().min(1).max(NICHE_TEXT_MAX).regex(/^[^\n\r]*$/, "one line") }),
]);

/** Folder names the studio creates: lowercase letters, digits and dashes only. */
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use lowercase letters, digits and dashes");
/** A music choice: a bundled track or an uploaded one, by file name. */
export const MusicId = z.string().regex(/^(bundled|upload):[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.mp3$/, "not a music id");

const CaptionChoice = z.union([CaptionStyleName, z.literal("preset")]);
const TransitionChoice = z.union([Transition, z.literal("auto")]);
const Gain = z.number().min(0).max(1);
const HookText = z.string().trim().min(1).max(60);

/** The new-video form. Every field maps to one `run` option; the enums are the CLI's own. */
export const NewVideo = z.object({
  topic: z.string().trim().min(1).max(500),
  aspect: Aspect.default("9:16"),
  /** About how long the video runs, in seconds: one of the lengths on offer. The script decides how many scenes that is. */
  durationSec: z.number().refine((n) => (VIDEO_SECONDS as readonly number[]).includes(n), "not a length a video can have").default(DEFAULT_VIDEO_SECONDS),
  /** How long each scene stays, in whole seconds: one length (both the same) or a range, within what a clip can be. */
  sceneSec: z.object({
    min: z.number().int().min(SCENE_SECONDS.min).max(SCENE_SECONDS.max),
    max: z.number().int().min(SCENE_SECONDS.min).max(SCENE_SECONDS.max),
  }).refine((r) => r.min <= r.max, "the shortest scene cannot be longer than the longest").default(DEFAULT_SCENE_SECONDS),
  style: z.union([PresetName, z.literal("auto")]).default("auto"),
  /**
   * What the video is made of: `stills` = generated pictures only, `clips` = generated clips only, `auto` = both,
   * each scene by how much happens in it. (It is where every scene's own switch starts on the draft's page.)
   */
  motion: z.enum(["auto", "clips", "stills"]).default("auto"),
  /** The size moving clips are generated at; 720p costs about twice as much. */
  clips: z.enum(["480p", "720p", "1080p"]).default("480p"),
  /** 60 = smooth motion (phase 11 spec §2); an older recipe without it is 30, and its command line is unchanged. */
  fps: z.union([z.literal(30), z.literal(60)]).default(30),
  brandKit: Slug.nullable().default(null),
  music: MusicId.nullable().default(null),
  musicGain: Gain.default(0.35),
  hook: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto") }),
    z.object({ mode: z.literal("custom"), text: HookText }),
    z.object({ mode: z.literal("off") }),
  ]).default({ mode: "auto" }),
  sfx: z.boolean().default(true),
  sfxGain: Gain.default(0.6),
  characters: z.string().trim().max(600).optional(),
  seed: z.number().int().min(0).max(MAX_SEED).optional(),
  /**
   * The kind of video (phase 7 spec §19): one of the studio's niches, one in the user's own words, or none. The
   * words are a description, quoted to the script's model as the user's, never read as instructions.
   */
  niche: NicheChoice.default({ kind: "none" }),
  /** The type of video (phase 8 spec §2): how it is told; absent = as its niche tells it. */
  format: z.enum(FORMAT_IDS).optional(),
  /** How it moves and is cut (phase 8 spec §3); absent = the studio's plain edit. */
  edit: z.enum(EDIT_IDS).optional(),
  /** The language the video is told in: the script is written in it and the voice speaks in it. */
  language: z.enum(SPEECH_LANGUAGE_CODES).default("en"),
  /**
   * Made for that language's viewers (phase 8 spec §5): who is in it, where the topic leaves it open. Turned off for
   * a video that will be made in other languages too; English has no one audience and is never made for one.
   */
  localize: z.boolean().default(true),
  /** One of the studio's voices; absent = the one the studio is set up with. */
  voiceId: z.enum(Object.keys(VOICES) as [VoiceId, ...VoiceId[]]).optional(),
  captionStyle: CaptionChoice.default("preset"),
  transition: TransitionChoice.default("auto"),
});
export type NewVideo = z.infer<typeof NewVideo>;

/** A request for topic ideas (phase 13): the form's language, niche and type; nothing else the studio holds. */
export const IdeasInput = z.object({
  language: z.enum(SPEECH_LANGUAGE_CODES),
  niche: NicheChoice.optional(),
  format: z.enum(FORMAT_IDS).optional(),
});
export type IdeasInput = z.infer<typeof IdeasInput>;

/** The command for an ideas job, in the one shape the worker accepts (`ideasRefusal`). */
export function ideasArgs(input: IdeasInput, capUsd?: number): string[] {
  const args = ["ideas", "--language", input.language];
  if (input.niche?.kind === "known") args.push("--niche", input.niche.id);
  if (input.niche?.kind === "custom") args.push("--niche-text", input.niche.text);
  if (input.format) args.push("--format", input.format);
  if (capUsd !== undefined) args.push("--cap", String(capUsd));
  return args;
}

/** What a series keeps of the form (phase 6 spec §3): everything but the topic, which each of its videos gets built. */
export const Recipe = NewVideo.omit({ topic: true });
export type Recipe = z.infer<typeof Recipe>;

export function musicPath(id: string): string {
  const [where, name] = id.split(":");
  const r = roots();
  return join(where === "bundled" ? r.music : r.uploads, name);
}

export const kitDir = (slug: string): string => join(roots().brandKits, slug);

/**
 * What the auto mode rules are told to keep a video's estimate under: the most a video may ever be approved for,
 * which is to say nothing. The studio asks for no budget: a video is priced once its script is written, its owner
 * is shown that and approves it, and what limits it is the credit they have (phase 6 spec §15).
 */
export const NO_BUDGET_USD = 100;

/**
 * The `run --draft` command line for a form. `soundOffered` is the studio's own answer (`health().sound`) at the moment
 * the draft is asked for: a video asks for scene sound only where the studio shows the switch. The CLI decides by its
 * own environment too, so without this a worker whose switch is on would buy sound for a customer whose studio said
 * nothing of it (a health answer that is stale, or not known while the worker was not answering).
 */
export function draftArgs(input: NewVideo, runId: string, soundOffered: boolean): string[] {
  const args = [
    "run", "--draft", "--yes", "--run-id", runId, "--topic", input.topic, "--aspect", input.aspect,
    "--duration", String(input.durationSec), "--scene-seconds", input.sceneSec.min === input.sceneSec.max ? String(input.sceneSec.min) : `${input.sceneSec.min}-${input.sceneSec.max}`,
    // (full HD is a 480p clip upscaled: phase 8 spec §8)
    "--language", input.language, "--mode", "auto", "--clips", input.clips === "1080p" ? "480p" : input.clips, "--budget", String(NO_BUDGET_USD),
    "--caption-style", input.captionStyle, "--transition", input.transition,
    "--bgm-gain", String(input.musicGain), "--sfx-gain", String(input.sfxGain),
  ];
  if (input.style !== "auto") args.push("--style", input.style);
  if (input.motion !== "auto") args.push("--pin-modes", input.motion === "clips" ? "1" : "2");
  if (input.brandKit) args.push("--brand", kitDir(input.brandKit));
  if (input.music) args.push("--bgm", musicPath(input.music));
  if (input.hook.mode === "custom") args.push("--hook", input.hook.text);
  if (input.hook.mode === "off") args.push("--no-hook");
  if (!input.sfx || !soundOffered) args.push("--no-sfx");
  if (input.characters) args.push("--characters", input.characters);
  if (input.seed !== undefined) args.push("--seed", String(input.seed));
  if (input.voiceId) args.push("--voice", input.voiceId);
  // (a form, or a series' recipe, from before niches has none)
  if (input.niche?.kind === "known") args.push("--niche", input.niche.id);
  if (input.niche?.kind === "custom") args.push("--niche-text", input.niche.text);
  if (input.format) args.push("--format", input.format);
  if (input.edit) args.push("--edit", input.edit);
  // (a series' recipe from before this is read as made for its audience, as every new video is: phase 8 spec §5)
  if (input.localize === false) args.push("--no-localize");
  if (input.clips === "1080p") args.push("--upscale");
  if (input.fps === 60) args.push("--fps", "60");
  return args;
}

/** Why the form's choices cannot go together, or null: a type that tells what is so cannot tell a made-up story. */
export function formProblem(input: Pick<NewVideo, "format" | "niche">): string | null {
  const clash = formatClash(input.format, input.niche?.kind === "known" ? nicheById(input.niche.id)?.kind : undefined);
  return clash ? `format: ${clash}` : null;
}

/**
 * Pending look changes from the studio: the free options `rerender` takes. `brandKit` names a kit to apply, null
 * removes the brand; an absent field keeps the run's current value.
 */
export const Look = z.object({
  captionStyle: CaptionChoice.optional(),
  transition: TransitionChoice.optional(),
  bgmGain: Gain.optional(),
  hook: z.union([HookText, z.literal(false)]).optional(),
  hookOn: z.boolean().optional(),
  sfx: z.boolean().optional(),
  sfxGain: Gain.optional(),
  brandKit: Slug.nullable().optional(),
}).strict();
export type Look = z.infer<typeof Look>;

/** The look as the pipeline's own flags, for a preview; a kit is read from its folder (not installed anywhere). */
export async function lookFlags(look: Look): Promise<{ flags: LookFlags; brandDir?: string }> {
  const { brandKit, bgmGain, sfxGain, ...rest } = look;
  const flags: LookFlags = {
    ...rest,
    ...(bgmGain === undefined ? {} : { bgmGain: String(bgmGain) }),
    ...(sfxGain === undefined ? {} : { sfxGain: String(sfxGain) }),
  };
  if (brandKit === undefined) return { flags };
  if (brandKit === null) return { flags: { ...flags, brand: null } };
  const dir = kitDir(brandKit);
  let kit;
  try {
    kit = await loadBrandKit(dir);
  } catch (err) {
    throw new ApiError("validation", err instanceof Error ? err.message : String(err));
  }
  return {
    flags: {
      ...flags,
      brand: { name: kit.name, logo: kit.logo, watermark: kit.watermark, ...(kit.font ? { font: kit.font } : {}), ...(kit.colors ? { colors: kit.colors } : {}) },
    },
    brandDir: dir,
  };
}

/** The `rerender` command line for a look (`look` takes the same options and only stores them). */
export function rerenderArgs(runId: string, look: Look, command: "rerender" | "look" = "rerender"): string[] {
  const args = [command, runId];
  if (look.captionStyle !== undefined) args.push("--caption-style", look.captionStyle);
  if (look.transition !== undefined) args.push("--transition", look.transition);
  if (look.bgmGain !== undefined) args.push("--bgm-gain", String(look.bgmGain));
  if (typeof look.hook === "string") args.push("--hook", look.hook);
  else if (look.hook === false) args.push("--no-hook");
  else if (look.hookOn) args.push("--hook-on");
  if (look.sfx !== undefined) args.push(look.sfx ? "--sfx" : "--no-sfx");
  if (look.sfxGain !== undefined) args.push("--sfx-gain", String(look.sfxGain));
  if (look.brandKit === null) args.push("--no-brand");
  else if (look.brandKit !== undefined) args.push("--brand", kitDir(look.brandKit));
  return args;
}

export const ModesBody = z.object({ modes: z.array(Mode.nullable()).min(1).max(MAX_SCENES) });
export const modesArg = (modes: Array<1 | 2 | null>): string => modes.map((m) => m ?? "auto").join(",");

const Reroll = z.object({ scene: z.number().int().min(1).max(MAX_SCENES), stage: z.enum(REROLLABLE) });
const Usd = z.number().min(0).max(1000);

/** What to price: continuing the run, a reroll, or a draft with other modes. */
export const PlanBody = z.object({ reroll: Reroll.optional(), modes: z.array(Mode.nullable()).optional() }).strict();
export const GenerateBody = z.object({ approvedUsd: Usd }).strict();
export const RerollBody = Reroll.extend({ approvedUsd: Usd }).strict();
/** A version of a run in another language (phase 8 spec §4.1): the language, a voice of it, and what was approved. */
export const VersionAsk = z.object({ language: z.enum(SPEECH_LANGUAGE_CODES), voiceId: z.enum(Object.keys(VOICES) as [VoiceId, ...VoiceId[]]).optional() }).strict();
export const VersionBody = VersionAsk.extend({ approvedUsd: Usd }).strict();
export const RerenderBody = z.object({ look: Look.default({}) }).strict();
export const PropsBody = z.object({ look: Look.default({}) }).strict();
