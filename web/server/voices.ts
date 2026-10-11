import { join } from "node:path";
import { BUILT_IN_VOICES, SPEECH_LANGUAGE_CODES, type SpeechLanguage, type VoiceId } from "@src/voice/language";
import { clipLanguages, designedVoices } from "@src/voice/library";
import { baseRoots } from "./config";

const dir = () => join(baseRoots().repo, "assets/voices");
/** The languages the voice worker's image has its own voices' clips in. */
const WORKER_CLIPS: readonly string[] = ["en", "tr"];

/** The voices a video can be asked for in now: the worker's own, and the designed ones whose clip has been made. */
export function readyVoices(): VoiceId[] {
  return [...BUILT_IN_VOICES, ...(designedVoices(dir()) as VoiceId[])];
}

/**
 * For each language, the voices that speak it from a clip made in it (phase 7 spec §16): the form offers those.
 * A voice spoken from a clip of another language carries that language's accent ("hör" for Turkish "her"). A
 * language that no voice has a clip in yet is offered the narrators, and the form says they are not native.
 */
export function nativeVoices(): Record<SpeechLanguage, VoiceId[]> {
  const ready = readyVoices();
  return Object.fromEntries(SPEECH_LANGUAGE_CODES.map((lang) => [
    lang,
    ready.filter((v) => (BUILT_IN_VOICES.includes(v) && WORKER_CLIPS.includes(lang)) || clipLanguages(v, dir()).includes(lang)),
  ])) as Record<SpeechLanguage, VoiceId[]>;
}
