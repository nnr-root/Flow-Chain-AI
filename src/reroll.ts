import type { Manifest } from "./manifest/schema.js";
import { referenceApplies } from "./stages/reference.js";
import { needsKeyframe } from "./stages/visual.js";

export const REROLLABLE = ["tts", "keyframes", "clips", "reference"] as const;
export type RerollStage = (typeof REROLLABLE)[number];

/**
 * Marks one scene-stage for regeneration by bumping its nonce. Downstream work (later chained clips,
 * fit, captions, render) re-runs automatically because its input hashes change.
 */
export function bumpNonce(m: Manifest, sceneNumber: number, stage: string): void {
  if (!(REROLLABLE as readonly string[]).includes(stage)) {
    throw new Error(`cannot reroll "${stage}" (use one of: ${REROLLABLE.join(", ")})`);
  }
  if (!Number.isInteger(sceneNumber) || sceneNumber < 1 || sceneNumber > m.scenes.length) {
    throw new Error(`--scene must be between 1 and ${m.scenes.length}`);
  }
  const idx = sceneNumber - 1;
  if (stage === "clips" && m.scenes[idx].mode === 2) {
    throw new Error(
      `scene ${sceneNumber} is Mode 2: it has no clip (the keyframe is animated at render time), so rerolling ` +
        `clips would change nothing; use --stage keyframes for a new image`,
    );
  }
  if (stage === "keyframes" && !needsKeyframe(m, idx)) {
    throw new Error(`scene ${sceneNumber} continues from the previous clip and has no keyframe; reroll its clips instead`);
  }
  if (stage === "reference") {
    if (idx !== 0) throw new Error("the reference portrait is made in scene 1; use --scene 1");
    if (!referenceApplies(m, 0)) {
      throw new Error(
        "this run has no generated reference portrait (it needs a RunPod run with characters and no brand-kit portrait)",
      );
    }
  }
  const s = stage as RerollStage;
  const scene = m.scenes[idx];
  scene.nonces[s] = (scene.nonces[s] ?? 0) + 1;
}
