import type { Edit } from "../edits.js";
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

/**
 * Whether scene i has a recurring character in its frame. Only a script that says no is read as no: one written
 * before the field existed is prompted exactly as it always was, so its stages keep their hashes.
 */
export function showsCharacter(script: Script, i: number): boolean {
  return script.scenes[i].showsCharacter !== false;
}

/**
 * Spec §6.1. Without a preset (runs scripted before 2.2) the Phase 1 wording is kept, so cache keys stay valid.
 * A scene without the character is not told about them: a picture model given a description (and a portrait)
 * puts that person into a staircase or a lantern room that was meant to be empty (phase 5 spec §9.12).
 */
/**
 * A scene's picture prompt. An edit's light and framing words come after the scene's own, so the subject still
 * leads (phase 8 spec §3); a run without one is asked for exactly as before.
 */
export function imagePrompt(script: Script, i: number, preset: StylePreset | null, edit?: Edit): string {
  const b = script.styleBible;
  const scene = script.scenes[i].imagePrompt;
  const who = showsCharacter(script, i) ? `${b.characters}. ` : "";
  // the time and place, in every picture: a scene that only says "hands on a map" is drawn in today's sleeves otherwise
  const when = b.setting ? `Setting: ${b.setting}. ` : "";
  const look = edit ? `. ${edit.picture}` : "";
  if (!preset) return `${b.artStyle}. ${when}${who}Palette: ${b.palette}. ${scene}${look}`;
  return `${preset.imagePrefix}. ${when}${who}Palette: ${b.palette}. ${scene}${look}. ${preset.imageSuffix}`;
}

/** What a scene's picture should show, in plain words, for the look at it (phase 8 spec §9). */
export function expectedOf(script: Script, i: number): string {
  const who = showsCharacter(script, i) ? `${script.styleBible.characters} ` : "";
  return `${who}${script.scenes[i].imagePrompt}`.trim();
}

export function motionPrompt(script: Script, i: number, preset: StylePreset | null, edit?: Edit): string {
  const b = script.styleBible;
  const own = edit ? `${script.scenes[i].motionPrompt}. ${edit.motion}` : script.scenes[i].motionPrompt;
  const motion = preset ? `${own}. ${preset.motionKeywords}` : own;
  const who = showsCharacter(script, i) ? ` ${b.characters}.` : "";
  const when = b.setting ? ` Setting: ${b.setting}.` : "";
  return `${motion}. Keep style consistent: ${b.artStyle}.${when}${who}`;
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
