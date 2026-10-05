import { join } from "node:path";
import type { Boundary, Transition } from "./remotion/props.js";

export type SfxName = "impact" | "whoosh" | "pop";

/**
 * The bundled sound effects (made by scripts/make-sfx.ts). `leadFrames` starts a sound early so its loudest
 * moment lands on its cue (the whoosh peaks 0.25 s in); `baseGain` levels the three against each other.
 */
export const SFX: Record<SfxName, { file: string; baseGain: number; leadFrames: number }> = {
  impact: { file: "impact_boom.mp3", baseGain: 1, leadFrames: 0 },
  whoosh: { file: "whoosh.mp3", baseGain: 0.8, leadFrames: 8 },
  pop: { file: "pop.mp3", baseGain: 0.7, leadFrames: 0 },
};

/** The sound for a cut with this transition: quiet ones (fade, dissolve) get none. */
const FOR_TRANSITION: Record<Transition, SfxName | null> = {
  cut: "pop", fade: null, dissolve: null, blur: "whoosh", zoom: "whoosh", glitch: "pop",
};

export type SfxCuePlan = { sound: SfxName; frame: number; gain: number };

/**
 * Where sound effects play (spec §5.2): an impact at frame 0 when the hook is shown, and the cut's sound at
 * every cut (never at a seam), started `leadFrames` early so its peak lands on the cut.
 */
export function sfxCues(boundaries: Boundary[], opts: { hook: boolean; gain: number }): SfxCuePlan[] {
  const cue = (sound: SfxName, at: number): SfxCuePlan => ({
    sound,
    frame: Math.max(0, at - SFX[sound].leadFrames),
    gain: opts.gain * SFX[sound].baseGain,
  });
  const cues = opts.hook ? [cue("impact", 0)] : [];
  for (const b of boundaries) {
    const sound = b.kind === "cut" ? FOR_TRANSITION[b.transition] : null;
    if (sound) cues.push(cue(sound, b.frame));
  }
  return cues;
}

export function sfxFiles(sfxDir: string): string[] {
  return Object.values(SFX).map((s) => join(sfxDir, s.file));
}
