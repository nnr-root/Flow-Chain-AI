import { existsSync } from "node:fs";
import { join } from "node:path";
import { round4 } from "./cost.js";
import { inputHash } from "./manifest/hash.js";
import type { Manifest, StageName, StageRecord } from "./manifest/schema.js";
import { saveManifest } from "./manifest/store.js";
import type { RunContext, Stage, StageContext } from "./stages/types.js";

export type WorkItem = { stage: StageName; scene?: number; costUsd: number };
export type Plan = { items: WorkItem[]; totalUsd: number };
export type ConfirmFn = (plan: Plan, reason: string) => Promise<boolean>;
export type RunOptions = {
  budgetUsd: number;
  confirm: ConfirmFn;
  yes?: boolean;
  /** Rerolls confirm whenever paid work is planned, regardless of budget. */
  reroll?: boolean;
  /** Force this stage and every later stage to re-run. */
  from?: StageName;
  onPlan?: (plan: Plan, label: string) => void;
};

/** Second confirmation point: script and audio exist here, so every remaining estimate is exact. */
export const MEDIA_CHECKPOINT: StageName = "keyframes";

export class RunAborted extends Error {
  constructor() {
    super("Run aborted: the estimated cost was not confirmed.");
  }
}

const key = (stage: StageName, scene?: number) => `${stage}:${scene ?? "-"}`;

function getRecord(m: Manifest, stage: StageName, scene?: number): StageRecord | undefined {
  return scene === undefined ? m.runStages[stage] : m.scenes[scene].stages[stage];
}

function setRecord(m: Manifest, stage: StageName, scene: number | undefined, record: StageRecord): void {
  if (scene === undefined) m.runStages[stage] = record;
  else m.scenes[scene].stages[stage] = record;
}

export function targets(stage: Stage, m: Manifest): Array<number | undefined> {
  if (!stage.perScene) return [undefined];
  return m.scenes.map((s) => s.idx).filter((i) => stage.appliesTo?.(m, i) ?? true);
}

export async function computeHash(ctx: StageContext, stage: Stage, scene?: number): Promise<string> {
  const nonce = scene === undefined ? 0 : (ctx.manifest.scenes[scene].nonces[stage.name] ?? 0);
  return inputHash(stage.name, { nonce, inputs: await stage.inputsFor(ctx, scene) });
}

/** Cache hit: last attempt succeeded, inputs are unchanged and every output file still exists. */
export async function isFresh(ctx: StageContext, stage: Stage, scene?: number): Promise<boolean> {
  const record = getRecord(ctx.manifest, stage.name, scene);
  if (record?.status !== "done") return false;
  let hash: string;
  try {
    hash = await computeHash(ctx, stage, scene);
  } catch {
    return false;
  }
  if (hash !== record.inputHash) return false;
  return stage.outputsFor(ctx.manifest, scene).every((p) => existsSync(join(ctx.dir, p)));
}

function forcedStages(stages: Stage[], from?: StageName): Set<StageName> {
  if (!from) return new Set();
  const i = stages.findIndex((s) => s.name === from);
  if (i < 0) throw new Error(`unknown stage "${from}"`);
  return new Set(stages.slice(i).map((s) => s.name));
}

/** Predicts which (stage, scene) pairs will run, propagating "will run" down each stage's deps(). */
export async function planRun(ctx: StageContext, stages: Stage[], forced = new Set<StageName>()): Promise<Plan> {
  const willRun = new Set<string>();
  const items: WorkItem[] = [];
  for (const stage of stages) {
    for (const scene of targets(stage, ctx.manifest)) {
      const upstream = stage.deps(ctx.manifest, scene).some((d) => willRun.has(key(d.stage, d.scene)));
      if (forced.has(stage.name) || upstream || !(await isFresh(ctx, stage, scene))) {
        willRun.add(key(stage.name, scene));
        items.push({ stage: stage.name, scene, costUsd: stage.paid ? stage.estimateCostUsd(ctx, scene) : 0 });
      }
    }
  }
  return { items, totalUsd: round4(items.reduce((sum, i) => sum + i.costUsd, 0)) };
}

export function formatPlan(plan: Plan, label: string): string {
  if (plan.items.length === 0) return `${label}: nothing to do`;
  const rows = plan.items.map((i) => {
    const where = i.scene === undefined ? "run" : `scene ${i.scene + 1}`;
    const cost = i.costUsd > 0 ? `$${i.costUsd.toFixed(4)}` : "free";
    return `  ${i.stage.padEnd(10)}${where.padEnd(12)}${cost}`;
  });
  return [`${label}: ${plan.items.length} step(s), estimated $${plan.totalUsd.toFixed(2)}`, ...rows].join("\n");
}

async function execute(ctx: StageContext, stage: Stage, scene?: number): Promise<void> {
  const hash = await computeHash(ctx, stage, scene);
  ctx.log(`▶ ${stage.name}${scene === undefined ? "" : ` scene ${scene + 1}`}`);
  // A failed attempt for the same inputs may already have spent money (e.g. a charged job whose download
  // failed); the record's costUsd is the total charged for this result.
  const prior = getRecord(ctx.manifest, stage.name, scene);
  let charged = prior?.status === "failed" && prior.inputHash === hash ? prior.costUsd : 0;
  const runCtx: RunContext = {
    ...ctx,
    inputHash: hash,
    charge: async (usd) => {
      if (!(usd > 0)) return;
      charged = round4(charged + usd);
      ctx.manifest.ledger.push({ stage: stage.name, scene, usd, at: new Date().toISOString() });
      await saveManifest(ctx.dir, ctx.manifest);
    },
  };
  try {
    await stage.run(runCtx, scene);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    setRecord(ctx.manifest, stage.name, scene, {
      status: "failed", inputHash: hash, costUsd: charged, finishedAt: new Date().toISOString(), error,
    });
    await saveManifest(ctx.dir, ctx.manifest);
    throw err;
  }
  setRecord(ctx.manifest, stage.name, scene, {
    status: "done", inputHash: hash, costUsd: charged, finishedAt: new Date().toISOString(),
  });
  await saveManifest(ctx.dir, ctx.manifest);
}

export async function runPipeline(ctx: StageContext, stages: Stage[], opts: RunOptions): Promise<void> {
  const forced = forcedStages(stages, opts.from);
  let accepted = 0;
  const checkpoint = async (remaining: Stage[], label: string) => {
    const plan = await planRun(ctx, remaining, forced);
    opts.onPlan?.(plan, label);
    ctx.log(formatPlan(plan, label));
    const needsConfirm = opts.reroll ? plan.totalUsd > 0 : plan.totalUsd > opts.budgetUsd;
    if (needsConfirm && plan.totalUsd > accepted + 0.01 && !opts.yes) {
      const reason = opts.reroll ? "reroll" : `over the $${opts.budgetUsd.toFixed(2)} budget`;
      if (!(await opts.confirm(plan, reason))) throw new RunAborted();
    }
    accepted = Math.max(accepted, plan.totalUsd);
  };

  await checkpoint(stages, "Plan");
  for (const [i, stage] of stages.entries()) {
    if (i > 0 && stage.name === MEDIA_CHECKPOINT) await checkpoint(stages.slice(i), "Media plan");
    for (const scene of targets(stage, ctx.manifest)) {
      if (!forced.has(stage.name) && (await isFresh(ctx, stage, scene))) continue;
      await execute(ctx, stage, scene);
    }
  }
}
