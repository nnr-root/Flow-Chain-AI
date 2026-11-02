import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { multiTenant } from "@/lib/accounts";
import { ideasPriceUsd } from "@/lib/ideas";
import { tenantFolder } from "./tenant";

/**
 * The data folders as they are on disk, for every user together. Only what looks after the whole disk may use
 * this (the worker's start-up sweep and its clean-up); everything else goes through `roots()`.
 */
export function baseRoots() {
  const repo = resolve(process.env.FLOWCHAIN_ROOT ?? join(process.cwd(), ".."));
  return {
    repo,
    runs: resolve(repo, process.env.RUNS_DIR ?? "runs"),
    uploads: resolve(repo, process.env.STUDIO_UPLOADS_DIR ?? "uploads/music"),
    brandKits: resolve(repo, process.env.BRAND_KITS_DIR ?? "brand-kits"),
  };
}

/**
 * Where the studio finds the pipeline. Read on every call (never cached) so tests can point each case at its
 * own folders. `npm run web` starts Next in `web/`, so the repository is the parent directory by default.
 *
 * In a studio with accounts `runs`, `brandKits` and `uploads` are the current user's own folders
 * (`<root>/<userId>`): code that reads or writes them outside a user's scope fails instead of reaching into
 * the shared root.
 */
export function roots() {
  const base = baseRoots();
  return {
    repo: base.repo,
    get runs() {
      return join(base.runs, tenantFolder());
    },
    fonts: join(base.repo, "assets/fonts"),
    music: join(base.repo, "assets/music"),
    get uploads() {
      return join(base.uploads, tenantFolder());
    },
    get brandKits() {
      return join(base.brandKits, tenantFolder());
    },
    /** A replacement for the CLI (tests use a stub script); undefined = `src/cli.ts` through tsx. */
    cli: process.env.FLOWCHAIN_CLI,
  };
}

/** How many jobs may run at once: `STUDIO_MAX_JOBS` when it is a whole number of at least 1, otherwise 2. */
export function maxJobs(): number {
  const raw = process.env.STUDIO_MAX_JOBS?.trim() ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) : 0;
  return value >= 1 ? value : 2;
}

/**
 * The pipeline's settings as the CLI will see them: the repository's `.env` under the real environment. Only
 * names and non-secret defaults ever leave this module; key values are never returned to a caller.
 */
function pipelineEnv(): Record<string, string | undefined> {
  const file = join(roots().repo, ".env");
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  return { ...fromFile, ...process.env };
}

const NEEDS = [
  "GEMINI_API_KEY", "RUNPOD_API_KEY", "RUNPOD_KEYFRAME_ENDPOINT",
  "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
] as const;
/** A voice: the hosted one's key, or the studio's own endpoint (phase 5 spec §11). Either will do. */
const VOICE_NEEDS = ["ELEVENLABS_API_KEY", "RUNPOD_VOICE_ENDPOINT"] as const;

export type Health = {
  /** Names of the settings a new run needs that are not set. */
  missing: string[];
  /**
   * Whether moving clips can be offered: the LTX endpoint is set and the owner switched it on (phase 15 spec §7, §13.8). LTX
   * is the only clip engine since Wan was removed (§13.10); a studio without it makes videos of pictures only. Present only
   * when true, like `smooth`. Its rates are the CLI's to check (the web never reads `prices.json`).
   */
  clips?: true;
  /** Whether full HD (upscaled clips, phase 8 spec §8) can be offered: its endpoint is set. */
  fullHd?: boolean;
  /**
   * Whether smooth motion (60 fps, phase 11 spec §2) can be offered. Never, for now: it was measured on Wan's 16 fps clips
   * only and the CLI refuses it for LTX's 24 fps ones (phase 15 spec §13.5), and Wan is gone (§13.10). Kept, absent, so the
   * form and the switch come back as they were once it is measured on LTX's clips.
   */
  smooth?: boolean;
  /** Whether topic ideas (phase 13) are offered: the key is there, the owner switched them on and, with accounts, a price is set. Present only when true, like `smooth`. */
  ideas?: true;
  /**
   * Whether scene sound (phase 14 spec §6) can be offered: its endpoint is set and the owner switched it on, or new runs'
   * clips are made on the LTX endpoint (set, and switched on by `FLOWCHAIN_LTX`), whose clips carry their own sound (phase 15 spec §13.7). Present only when true,
   * like `smooth`. Its prices are not read here (the web never reads `prices.json`): the CLI's own gate decides at
   * creation, and a run made without them is made without sound and says so.
   */
  sound?: true;
  /**
   * Whether a character may speak in a video (phase 15 spec §5, §7): new runs' clips are made on the endpoint that makes
   * sound and the owner switched speech on. Present only when true, like `sound`; prices are the CLI's to check.
   */
  speech?: true;
};

/** Whether a new run could be made, checked without any network call. */
export function health(): Health {
  const env = pipelineEnv();
  const unset = (names: readonly string[]) => names.filter((n) => !env[n]?.trim());
  // While the LTX endpoint is set and switched on it makes new runs' clips (phase 15 spec §7); without it a studio still makes
  // videos of pictures only, so it is not "missing" anything (Wan's endpoint, which made clips before, is gone: §13.10).
  // The trade-off: LTX is used only with its three rates too, and the web never reads `prices.json`. Between a deploy
  // (which writes the endpoint) and the owner setting the rates, a studio offers clips, sound and (switched on) speech,
  // and a run that may need a clip is refused by the CLI's own check in one plain sentence.
  // (only while the owner switched it on, as the CLI requires for a new run: the endpoint alone changes nothing)
  const ltx = env.FLOWCHAIN_LTX?.trim() === "on" && Boolean(env.RUNPOD_LTX_ENDPOINT?.trim());
  return {
    missing: [...unset(NEEDS), ...(unset(VOICE_NEEDS).length === VOICE_NEEDS.length ? [`${VOICE_NEEDS[0]} (or ${VOICE_NEEDS[1]})`] : [])],
    ...(ltx ? { clips: true as const } : {}),
    fullHd: Boolean(env.RUNPOD_UPSCALE_ENDPOINT?.trim()),
    // an LTX clip carries its own sound (phase 15 spec §13.7): without this the form would send --no-sfx and it would be silent
    ...(ltx || (env.RUNPOD_FOLEY_ENDPOINT?.trim() && env.FLOWCHAIN_SCENE_SOUND?.trim() === "on") ? { sound: true as const } : {}),
    ...(ltx && env.FLOWCHAIN_SPEECH?.trim() === "on" ? { speech: true as const } : {}),
    ...(env.GEMINI_API_KEY?.trim() && env.FLOWCHAIN_TREND_IDEAS?.trim() === "on" && (!multiTenant() || ideasPriceUsd() !== undefined) ? { ideas: true as const } : {}),
  };
}
