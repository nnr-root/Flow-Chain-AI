import { imageProfileOf } from "../image-profiles.js";
import type { LedgerEntry, Manifest, Mode, Models, StageName, StageRecord } from "../manifest/schema.js";
import { round4 } from "../cost.js";
import { effectivePreset, hookTextFor } from "../stages/look.js";
import { referenceApplies } from "../stages/reference.js";
import { needsKeyframe } from "../stages/visual.js";
import { videoProfileOf } from "../video-profiles.js";
import { isDraft } from "./draft.js";

export const RUN_STAGES: StageName[] = ["script", "modes", "captions", "render"];
export const SCENE_STAGES: StageName[] = ["reference", "tts", "silence", "keyframes", "clips", "fit"];

/** The stages a scene actually has: keyframes only where it needs one, clips and fit only for Mode 1. */
export function sceneStagesShown(m: Manifest, idx: number): StageName[] {
  return SCENE_STAGES.filter(
    (s) =>
      (s !== "reference" || referenceApplies(m, idx)) &&
      (s !== "keyframes" || needsKeyframe(m, idx)) &&
      ((s !== "clips" && s !== "fit") || m.scenes[idx].mode === 1),
  );
}

export type StepStatus = { stage: StageName; status: "pending" | "done" | "failed"; error?: string };
export type SceneStatus = {
  /** 1-based, as shown everywhere. */
  scene: number;
  mode: Mode;
  modeReason?: string;
  /** The user's pin for this scene on an auto run, or null when the rules decide. */
  override: Mode | null;
  narration?: string;
  imagePrompt?: string;
  shot?: string;
  actionLevel?: string;
  audioSec?: number;
  steps: StepStatus[];
};
export type RunStatus = {
  runId: string;
  createdAt: string;
  topic: string;
  aspect: string;
  sceneCount: number;
  modes: Mode[] | "auto";
  title?: string;
  style: { name: string | null; source: "flag" | "auto" | "pending" | "none" };
  hook: string | null;
  render: Manifest["request"]["render"];
  characters?: string;
  seed?: number;
  imageProfile: string;
  videoProfile: string;
  models: Models;
  bgm?: string;
  /** Only the script exists: modes can still be changed and the preview shows placeholders. */
  draft: boolean;
  runSteps: StepStatus[];
  scenes: SceneStatus[];
  spendUsd: number;
  ledger: LedgerEntry[];
  final?: Manifest["final"];
};

const step = (stage: StageName, r?: StageRecord): StepStatus =>
  r === undefined ? { stage, status: "pending" } : { stage, status: r.status, ...(r.error ? { error: r.error } : {}) };

/** A run's progress, errors and spend as data: what `status` prints and what the studio shows. */
export function statusOf(m: Manifest): RunStatus {
  const r = m.request;
  const preset = effectivePreset(m);
  return {
    runId: m.runId,
    createdAt: m.createdAt,
    topic: r.topic,
    aspect: r.aspect,
    sceneCount: r.sceneCount,
    modes: r.modes ?? "auto",
    title: m.script?.title,
    style: preset
      ? { name: preset.name, source: r.style ? "flag" : "auto" }
      : { name: null, source: m.script ? "none" : "pending" },
    hook: hookTextFor(m),
    render: r.render,
    characters: r.characters,
    seed: r.seed,
    imageProfile: imageProfileOf(r.imageProfile).id,
    videoProfile: videoProfileOf(r.videoProfile).id,
    models: m.models,
    bgm: r.bgm,
    draft: isDraft(m),
    runSteps: RUN_STAGES.map((s) => step(s, m.runStages[s])),
    scenes: m.scenes.map((scene) => {
      const spec = m.script?.scenes[scene.idx];
      return {
        scene: scene.idx + 1,
        mode: scene.mode,
        modeReason: scene.modeReason,
        override: r.modeOverrides?.[scene.idx] ?? null,
        narration: spec?.narration,
        imagePrompt: spec?.imagePrompt,
        shot: spec?.shot,
        actionLevel: spec?.actionLevel,
        audioSec: scene.audio?.duration,
        steps: sceneStagesShown(m, scene.idx).map((s) => step(s, scene.stages[s])),
      };
    }),
    spendUsd: round4(m.ledger.reduce((sum, e) => sum + e.usd, 0)),
    ledger: m.ledger,
    final: m.final,
  };
}
