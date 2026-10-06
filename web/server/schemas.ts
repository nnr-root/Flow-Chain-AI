import { join } from "node:path";
import { loadBrandKit } from "@src/brand";
import { Aspect } from "@src/config";
import { MAX_SCENES, MAX_SEED, Mode } from "@src/manifest/schema";
import { CaptionStyleName, Transition } from "@src/media/remotion/props";
import { PresetName } from "@src/presets";
import { REROLLABLE } from "@src/reroll";
import type { LookFlags } from "@src/studio/props";
import { z } from "zod";
import { roots } from "./config";
import { ApiError } from "./http";

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
  scenes: z.number().int().min(1).max(MAX_SCENES).default(4),
  style: z.union([PresetName, z.literal("auto")]).default("auto"),
  /** The starting position of every scene's mode switch. */
  motion: z.enum(["auto", "clips", "stills"]).default("auto"),
  provider: z.enum(["fal", "runpod"]),
  /** Frozen with the run: the auto mode rules keep the estimate under it. */
  budgetUsd: z.number().positive().max(100),
  brandKit: Slug.nullable().default(null),
  music: MusicId.nullable().default(null),
  musicGain: Gain.default(0.35),
  hook: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("gemini") }),
    z.object({ mode: z.literal("custom"), text: HookText }),
    z.object({ mode: z.literal("off") }),
  ]).default({ mode: "gemini" }),
  sfx: z.boolean().default(true),
  sfxGain: Gain.default(0.6),
  characters: z.string().trim().max(600).optional(),
  seed: z.number().int().min(0).max(MAX_SEED).optional(),
  voiceId: z.string().trim().min(1).max(100).optional(),
  captionStyle: CaptionChoice.default("preset"),
  transition: TransitionChoice.default("auto"),
});
export type NewVideo = z.infer<typeof NewVideo>;

export function musicPath(id: string): string {
  const [where, name] = id.split(":");
  const r = roots();
  return join(where === "bundled" ? r.music : r.uploads, name);
}

export const kitDir = (slug: string): string => join(roots().brandKits, slug);

/** The `run --draft` command line for a form. */
export function draftArgs(input: NewVideo, runId: string): string[] {
  const args = [
    "run", "--draft", "--yes", "--run-id", runId, "--topic", input.topic, "--aspect", input.aspect,
    "--scenes", String(input.scenes), "--mode", "auto", "--provider", input.provider, "--budget", String(input.budgetUsd),
    "--caption-style", input.captionStyle, "--transition", input.transition,
    "--bgm-gain", String(input.musicGain), "--sfx-gain", String(input.sfxGain),
  ];
  if (input.style !== "auto") args.push("--style", input.style);
  if (input.motion !== "auto") args.push("--pin-modes", input.motion === "clips" ? "1" : "2");
  if (input.brandKit) args.push("--brand", kitDir(input.brandKit));
  if (input.music) args.push("--bgm", musicPath(input.music));
  if (input.hook.mode === "custom") args.push("--hook", input.hook.text);
  if (input.hook.mode === "off") args.push("--no-hook");
  if (!input.sfx) args.push("--no-sfx");
  if (input.characters) args.push("--characters", input.characters);
  if (input.seed !== undefined) args.push("--seed", String(input.seed));
  if (input.voiceId) args.push("--voice", input.voiceId);
  return args;
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
export const RerenderBody = z.object({ look: Look.default({}) }).strict();
export const PropsBody = z.object({ look: Look.default({}) }).strict();
