import type { Manifest, Mode, StageName } from "../manifest/schema.js";
import { saveManifest } from "../manifest/store.js";
import { forcedStages, type Plan, planRun, type RunOptions, runPipeline } from "../pipeline.js";
import { bumpNonce } from "../reroll.js";
import { scriptStage } from "../stages/script.js";
import type { Stage, StageContext } from "../stages/types.js";
import { setDraftModes } from "./draft.js";

/** Matches `newRunId()`; a caller-chosen id (the studio's) must look the same. */
export const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

/**
 * Buys the script and stops: a draft. On an auto run it then writes each scene's provisional mode (with any
 * pins given at creation), so the run can be previewed and priced before its media is bought. `resume` continues.
 */
export async function runDraft(ctx: StageContext, opts: RunOptions): Promise<void> {
  await runPipeline(ctx, [scriptStage], opts);
  const m = ctx.manifest;
  if (m.request.modes) return;
  setDraftModes(m, m.request.modeOverrides ?? m.scenes.map(() => null), ctx.keyframeSize);
  await saveManifest(ctx.dir, m);
}

export type PlanQuery = {
  from?: StageName;
  /** Price regenerating this scene's stage (1-based scene). */
  reroll?: { scene: number; stage: string };
  /** Price the run as if these modes were pinned (drafts only). */
  modes?: Array<Mode | null>;
};
export type PlanJson = { items: Array<{ stage: StageName; scene: number | null; costUsd: number }>; totalUsd: number };

/** What an action would run and cost, without doing or saving anything: `ctx.manifest` must be a copy. */
export async function planQuery(ctx: StageContext, stages: Stage[], query: PlanQuery = {}): Promise<PlanJson> {
  if (query.modes) setDraftModes(ctx.manifest, query.modes, ctx.keyframeSize);
  if (query.reroll) bumpNonce(ctx.manifest, query.reroll.scene, query.reroll.stage);
  return planJson(await planRun(ctx, stages, forcedStages(stages, query.from)));
}

/** Scenes are 1-based in the JSON, as everywhere a person reads them. */
export function planJson(plan: Plan): PlanJson {
  return {
    items: plan.items.map((i) => ({ stage: i.stage, scene: i.scene === undefined ? null : i.scene + 1, costUsd: i.costUsd })),
    totalUsd: plan.totalUsd,
  };
}

/** A copy safe to plan on: planning with pins or a reroll must never reach the run's manifest on disk. */
export const planningCopy = (m: Manifest): Manifest => structuredClone(m);
