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
  /** Base backoff for provider retries (tests use 0). */
  retryDelayMs: number;
  log: (message: string) => void;
};

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
  /** Does the work, updates ctx.manifest and returns the USD to record in the ledger. */
  run(ctx: StageContext, scene?: number): Promise<number>;
}
