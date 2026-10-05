import { join } from "node:path";

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

export function sfxFiles(sfxDir: string): string[] {
  return Object.values(SFX).map((s) => join(sfxDir, s.file));
}
