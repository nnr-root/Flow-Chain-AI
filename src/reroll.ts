import type { Manifest } from "./manifest/schema.js";
import { referenceApplies } from "./stages/reference.js";
import { isSmoothed } from "./stages/interpolate.js";
import { RETIRED_SOUND_ENGINE } from "./sound.js";
import { hasSceneSound } from "./stages/sound.js";
import { isUpscaled } from "./stages/upscale.js";
import { needsKeyframe } from "./stages/visual.js";

// (a full HD clip too, phase 8 spec §8: a failed upscale is kept for its inputs, and only a new nonce asks again)
// ("sound" is still a name the CLI and the studio's API accept, but nothing can be rerolled by it: a scene's sound is its
// clip's, made again with its clip, and an old run's bought sound can no longer be bought, phase 15 spec §13.12)
export const REROLLABLE = ["tts", "keyframes", "clips", "upscale", "interpolate", "sound", "reference"] as const;
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
  if (stage === "upscale" && !isUpscaled(m, idx)) {
    throw new Error(`scene ${sceneNumber} has no full HD clip: only a moving clip of a run made in full HD is upscaled`);
  }
  if (stage === "interpolate" && !isSmoothed(m, idx)) {
    throw new Error(`scene ${sceneNumber} has no smoothed clip: only a moving clip of a 60 fps run that is not in full HD is smoothed on its own`);
  }
  if (stage === "sound") {
    // refused here, before anything is planned: an old run's sound would have to be bought, and a clip's own is remade
    // only with its clip
    if (hasSceneSound(m, idx)) throw new Error(RETIRED_SOUND_ENGINE);
    throw new Error(`scene ${sceneNumber}'s sound cannot be remade on its own: a scene's sound is its clip's, and comes new with a new clip`);
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
