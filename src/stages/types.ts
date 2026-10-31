import type { Prices, Size } from "../config.js";
import type { Manifest, StageName } from "../manifest/schema.js";
import type { Providers } from "../providers/types.js";

export type StageContext = {
  /** Absolute run directory; every path stored in the manifest is relative to it. */
  dir: string;
  manifest: Manifest;
  providers: Providers;
  prices: Prices;
  size: Size;
  keyframeSize: Size;
  fps: number;
  fontsDir: string;
  /** Gone with the phase 12 library (phase 14); optional only so the pinned compat test's contexts still type-check. Nothing reads it. */
  sfxDir?: string;
  /** Base backoff for provider retries (tests use 0). */
  retryDelayMs: number;
  /** Remotion render concurrency (null/undefined = Remotion's default). Speed only, not part of any cache key. */
  renderConcurrency?: number | null;
  log: (message: string) => void;
};

/** What the pipeline hands to one execution of `run()`. */
export type RunContext = StageContext & {
  /** The inputHash this execution produces a result for (keys persisted provider jobs). */
  inputHash: string;
  /**
   * Records spend the moment a provider call has succeeded: appends a ledger entry and saves the manifest,
   * so money already spent stays recorded even if a later download or post-processing step fails.
   */
  charge(usd: number): Promise<void>;
};

/**
 * The frame rate a clip was made at (phase 15 spec §13.5): its own where it recorded one (LTX's 24), else Wan's 16, the
 * rate of every clip made before (whose file arrives at 32 after the Wan worker's own RIFE). `ctx.fps` is the video's.
 * Fit and the seam frame do not need it (ffmpeg's fps filter resamples to the video's rate and the plan is in seconds);
 * smooth motion does, as it was measured on Wan's clips only.
 */
export const clipFps = (clip: { fps?: number }): number => clip.fps ?? 16;

export type Dep = { stage: StageName; scene?: number };

export interface Stage {
  name: StageName;
  perScene: boolean;
  paid: boolean;
  /** Per-scene stages only: whether this scene needs the stage at all (default: every scene). */
  appliesTo?(m: Manifest, scene: number): boolean;
  /** Upstream (stage, scene) pairs. Used only to price cascades before running; execution relies on hashes. */
  deps(m: Manifest, scene?: number): Dep[];
  /** Everything the output depends on, including upstream file hashes. Throws if upstream data is missing. */
  inputsFor(ctx: StageContext, scene?: number): Promise<unknown>;
  /** Run-relative files that must exist for a cache hit. */
  outputsFor(m: Manifest, scene?: number): string[];
  /** Must not throw when upstream data is missing; fall back to conservative assumptions. */
  estimateCostUsd(ctx: StageContext, scene?: number): number;
  /** Does the work and updates ctx.manifest. Paid stages record spend with ctx.charge() right after each provider success. */
  run(ctx: RunContext, scene?: number): Promise<void>;
}
