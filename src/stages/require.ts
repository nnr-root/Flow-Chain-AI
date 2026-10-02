import type { Manifest, SceneState, Script } from "../manifest/schema.js";

type Field<K extends keyof SceneState> = NonNullable<SceneState[K]>;

function need<K extends keyof SceneState>(scene: SceneState, key: K, what: string): Field<K> {
  const value = scene[key];
  if (value === undefined || value === null) throw new Error(`scene ${scene.idx + 1} has no ${what} yet`);
  return value as Field<K>;
}

export function requireScript(m: Manifest): Script {
  if (!m.script) throw new Error("the script has not been generated yet");
  return m.script;
}

export const requireTts = (s: SceneState) => need(s, "tts", "voiceover");
export const requireAudio = (s: SceneState) => need(s, "audio", "trimmed audio");
export const requireClip = (s: SceneState) => need(s, "clip", "clip");
export const requireFitted = (s: SceneState) => need(s, "fitted", "fitted clip");
