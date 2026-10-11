import { BUILT_IN_VOICES, type VoiceId } from "@src/voice/language";
import { designedVoices } from "@src/voice/library";

/** The voices a video can be asked for in now: the worker's own, and the designed ones whose clip has been made. */
export function readyVoices(): VoiceId[] {
  return [...BUILT_IN_VOICES, ...(designedVoices() as VoiceId[])];
}
