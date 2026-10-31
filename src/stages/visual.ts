import type { Edit } from "../edits.js";
import type { Manifest, Script } from "../manifest/schema.js";
import { sceneFrameCounts } from "../media/timeline.js";
import type { StylePreset } from "../presets.js";
import type { VideoProfileId } from "../video-profiles.js";
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
 * The prompt a scene's clip is asked with. An LTX run sends the script's own `videoPrompt` and nothing else: the
 * preset's motion keywords, the edit's motion words ("cinematic") and the art style pull LTX towards a widescreen film
 * look in a vertical frame (phase 15 spec §1, §4). A scene without one (a script written before it) falls back to the
 * motion prompt; every other profile is asked exactly as before, so its clips keep their keys.
 */
export function clipPrompt(script: Script, i: number, preset: StylePreset | null, edit: Edit | undefined, profile: VideoProfileId | undefined): string {
  const own = script.scenes[i].videoPrompt?.trim();
  if (profile === "ltx25@1" && own) return own;
  return motionPrompt(script, i, preset, edit);
}

/**
 * Auto runs: the modes stage decides which scenes need keyframes, clips and fits, so those stages are priced
 * as dirty when it will run. Explicit runs (and every run made before 2.2) never list it.
 */
export function autoModeDeps(m: Manifest): Dep[] {
  return m.request.modes ? [] : [{ stage: "modes" }];
}

/**
 * Whether a person speaks in scene i (phase 15 spec §5, §13.2): its clip is made with the sentence, and its sound, its
 * length and its words come from that clip. Only in a run that allows speech: a sentence a script wrote in one that
 * does not would buy a clip of its own, so it is not read at all.
 */
export function isSpeaking(m: Manifest, i: number): boolean {
  // (and only on LTX, the one engine that speaks: another would buy a clip that has no voice in it)
  return m.request.speech === true && m.request.videoProfile === "ltx25@1" && (m.script?.scenes[i]?.speech?.trim() ?? "") !== "";
}

/**
 * What decides scene k's length (phase 15 spec §13.3), and the only place that says it: its trimmed voiceover, or the
 * clip of a scene that speaks. Every stage that reads an earlier scene's length depends on this.
 */
export function durationDep(m: Manifest, k: number): Dep {
  return isSpeaking(m, k) ? { stage: "clips", scene: k } : { stage: "silence", scene: k };
}

/**
 * Frames per scene. A scene's count depends only on the lengths up to its own, so `upTo` reads no later scene: a later
 * scene that speaks has no length until its clip is made, which is after the clips before it.
 */
export function sceneFrames(m: Manifest, fps: number, upTo = m.scenes.length - 1): number[] {
  return sceneFrameCounts(
    m.scenes.slice(0, upTo + 1).map((s) => requireAudio(s).duration),
    fps,
  );
}
