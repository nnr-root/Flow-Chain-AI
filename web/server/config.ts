import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
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
    sfx: join(base.repo, "assets/sfx"),
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
  "GEMINI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID",
  "RUNPOD_API_KEY", "RUNPOD_KEYFRAME_ENDPOINT", "RUNPOD_CLIP_ENDPOINT",
  "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
] as const;

export type Health = {
  /** Names of the settings a new run needs that are not set. */
  missing: string[];
  defaults: { budgetUsd: number };
};

/** Whether a new run could be made, checked without any network call. */
export function health(): Health {
  const env = pipelineEnv();
  const unset = (names: readonly string[]) => names.filter((n) => !env[n]?.trim());
  const budget = Number(env.FLOWCHAIN_BUDGET_USD);
  return {
    // the hosted voice's two keys are needed only while the studio's own voice is not set up
    missing: unset(NEEDS).filter((name) => !(name.startsWith("ELEVENLABS_") && env.RUNPOD_VOICE_ENDPOINT?.trim())),
    defaults: { budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 3 },
  };
}
