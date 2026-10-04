import type { Manifest, Script } from "../manifest/schema.js";
import { sceneFrameCounts } from "../media/timeline.js";
import type { StylePreset } from "../presets.js";
import { requireAudio } from "./require.js";
import type { Dep } from "./types.js";

/** Spec §4.1. Before the script exists, `shot` is unknown and treated as "continue". */
export function needsKeyframe(m: Manifest, i: number): boolean {
  if (i === 0 || m.scenes[i].mode === 2 || m.scenes[i - 1].mode === 2) return true;
  return m.script?.scenes[i]?.shot === "cut";
}

/** Spec §6.1. Without a preset (runs scripted before 2.2) the Phase 1 wording is kept, so cache keys stay valid. */
export function imagePrompt(script: Script, i: number, preset: StylePreset | null): string {
  const b = script.styleBible;
  const scene = script.scenes[i].imagePrompt;
  if (!preset) return `${b.artStyle}. ${b.characters}. Palette: ${b.palette}. ${scene}`;
  return `${preset.imagePrefix}. ${b.characters}. Palette: ${b.palette}. ${scene}. ${preset.imageSuffix}`;
}

export function motionPrompt(script: Script, i: number, preset: StylePreset | null): string {
  const b = script.styleBible;
  const motion = preset ? `${script.scenes[i].motionPrompt}. ${preset.motionKeywords}` : script.scenes[i].motionPrompt;
  return `${motion}. Keep style consistent: ${b.artStyle}. ${b.characters}.`;
}

/**
 * Auto runs: the modes stage decides which scenes need keyframes, clips and fits, so those stages are priced
 * as dirty when it will run. Explicit runs (and every run made before 2.2) never list it.
 */
export function autoModeDeps(m: Manifest): Dep[] {
  return m.request.modes ? [] : [{ stage: "modes" }];
}

export function sceneFrames(m: Manifest, fps: number): number[] {
  return sceneFrameCounts(
    m.scenes.map((s) => requireAudio(s).duration),
    fps,
  );
}
