import { takesSeveralReferences } from "../image-profiles.js";
import type { Manifest } from "../manifest/schema.js";
import { paths } from "./paths.js";
import { referenceFor } from "./reference.js";
import { needsKeyframe } from "./visual.js";

/** The scene of the run's first keyframe: the look the others share (phase 10 spec §5). */
export const anchorScene = (m: Manifest): number => m.scenes.findIndex((s) => needsKeyframe(m, s.idx));

/** The nearest earlier scene that has a keyframe of its own, or -1. */
export function previousKeyframeScene(m: Manifest, scene: number): number {
  for (let j = scene - 1; j >= 0; j--) if (needsKeyframe(m, j)) return j;
  return -1;
}

/** Whether scene `scene` is a reframe: a cut to the same place from a new view, in a run that froze cut references. */
export function reframes(m: Manifest, scene: number): boolean {
  const s = m.script?.scenes[scene];
  return m.request.cutReferences === true && takesSeveralReferences(m.request.imageProfile) && scene > 0 && s?.shot === "cut" && s.reframe === true;
}

/**
 * The pictures scene `scene`'s keyframe is conditioned on, run-relative and in order: the character portrait
 * where the scene shows the character, the look anchor (every keyframe after the first), and for a reframe the
 * previous keyframe. Empty for a profile that takes one reference: it keeps its single portrait field.
 */
export function referencesFor(m: Manifest, scene: number): string[] {
  if (!takesSeveralReferences(m.request.imageProfile)) return [];
  const out: string[] = [];
  const portrait = referenceFor(m, scene);
  if (portrait) out.push(portrait);
  if (m.request.cutReferences === true) {
    const anchor = anchorScene(m);
    if (scene > anchor) out.push(paths.keyframe(anchor));
    if (reframes(m, scene)) {
      const prev = previousKeyframeScene(m, scene);
      if (prev >= 0 && prev !== anchor) out.push(paths.keyframe(prev));
    }
  }
  return out;
}

/** The keyframes scene `scene`'s keyframe must wait for: its anchor and, for a reframe, its previous picture. */
export function referenceScenes(m: Manifest, scene: number): number[] {
  if (!takesSeveralReferences(m.request.imageProfile) || m.request.cutReferences !== true) return [];
  const out: number[] = [];
  const anchor = anchorScene(m);
  if (scene > anchor) out.push(anchor);
  if (reframes(m, scene)) {
    const prev = previousKeyframeScene(m, scene);
    if (prev >= 0 && prev !== anchor) out.push(prev);
  }
  return out;
}

/**
 * Said to the picture model beside a look reference (phase 10 spec §5). The model draws on every picture it is
 * given, and the 4B one copied whatever stood in a portrait (phase 5 spec §9.12): the anchor is for the look only.
 */
export const REFERENCE_NOTE = "Use the reference pictures only for light, palette and grain, and for the surroundings of the same place; do not copy their objects, poses or people.";

/** The note for scene `scene`'s picture prompt: only where it has a look anchor or a previous picture to draw on. */
export const referenceNoteFor = (m: Manifest, scene: number): string => (referencesFor(m, scene).some((p) => p.includes("keyframe")) ? REFERENCE_NOTE : "");
