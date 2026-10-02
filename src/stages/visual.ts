import type { Manifest, Script } from "../manifest/schema.js";
import { sceneFrameCounts } from "../media/timeline.js";
import { paths } from "./paths.js";
import { requireAudio } from "./require.js";

/** Spec §4.1. Before the script exists, `shot` is unknown and treated as "continue". */
export function needsKeyframe(m: Manifest, i: number): boolean {
  if (i === 0 || m.scenes[i].mode === 2 || m.scenes[i - 1].mode === 2) return true;
  return m.script?.scenes[i]?.shot === "cut";
}

/** The image a scene's clip starts from: its own keyframe, or the previous clip's last frame. */
export function chainImagePath(m: Manifest, i: number): string {
  return needsKeyframe(m, i) ? paths.keyframe(i) : paths.lastFrame(i - 1);
}

export function imagePrompt(script: Script, i: number): string {
  const b = script.styleBible;
  return `${b.artStyle}. ${b.characters}. Palette: ${b.palette}. ${script.scenes[i].imagePrompt}`;
}

export function motionPrompt(script: Script, i: number): string {
  const b = script.styleBible;
  return `${script.scenes[i].motionPrompt}. Keep style consistent: ${b.artStyle}. ${b.characters}.`;
}

export function sceneFrames(m: Manifest, fps: number): number[] {
  return sceneFrameCounts(
    m.scenes.map((s) => requireAudio(s).duration),
    fps,
  );
}
