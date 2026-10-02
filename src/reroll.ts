import type { Manifest } from "./manifest/schema.js";
import { needsKeyframe } from "./stages/visual.js";

export const REROLLABLE = ["tts", "keyframes", "clips"] as const;
export type RerollStage = (typeof REROLLABLE)[number];

/**
 * Marks one scene-stage for regeneration by bumping its nonce. Downstream work (later chained clips,
 * fit, captions, assemble) re-runs automatically because its input hashes change.
 */
export function bumpNonce(m: Manifest, sceneNumber: number, stage: string): void {
  if (!(REROLLABLE as readonly string[]).includes(stage)) {
    throw new Error(`cannot reroll "${stage}" (use one of: ${REROLLABLE.join(", ")})`);
  }
  if (!Number.isInteger(sceneNumber) || sceneNumber < 1 || sceneNumber > m.scenes.length) {
    throw new Error(`--scene must be between 1 and ${m.scenes.length}`);
  }
  const idx = sceneNumber - 1;
  if (stage === "keyframes" && !needsKeyframe(m, idx)) {
    throw new Error(`scene ${sceneNumber} continues from the previous clip and has no keyframe; reroll its clips instead`);
  }
  const s = stage as RerollStage;
  const scene = m.scenes[idx];
  scene.nonces[s] = (scene.nonces[s] ?? 0) + 1;
}
