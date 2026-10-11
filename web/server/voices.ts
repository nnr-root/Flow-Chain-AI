import { join } from "node:path";
import { BUILT_IN_VOICES, SPEECH_LANGUAGE_CODES, type SpeechLanguage, type VoiceId, VOICES } from "@src/voice/language";
import { hostedLanguages, hostedNames, hostedRoles } from "@src/voice/hosted";
import { clipLanguages, designedVoices } from "@src/voice/library";
import { baseRoots } from "./config";

const dir = () => join(baseRoots().repo, "assets/voices");
/** The languages the voice worker's image has its own voices' clips in. */
const WORKER_CLIPS: readonly string[] = ["en", "tr"];

/**
 * Whether the studio's voices are the hosted service's (phase 5 spec §11): they are once a voice of it has been
 * chosen for any of them. The web app holds no provider key and cannot ask the worker; the catalogue in the code
 * is what both go by (the worker speaks a run there while its key is set, and `doctor` says when it is not).
 */
const hosted = (): boolean => hostedRoles(dir()).length > 0;

/** The voices a video can be asked for in now: the hosted ones chosen, else the worker's own and the designed ones made. */
export function readyVoices(): VoiceId[] {
  if (hosted()) return hostedRoles(dir()).filter((v): v is VoiceId => Object.hasOwn(VOICES, v));
  return [...BUILT_IN_VOICES, ...(designedVoices(dir()) as VoiceId[])];
}

/**
 * For each language, the voices native to it (phase 7 spec §16, phase 5 spec §11): the form offers those. A voice
 * of another language carries that language's accent ("hör" for Turkish "her"). A language with none yet is
 * offered the narrators, and the form says they are not native.
 */
export function nativeVoices(): Record<SpeechLanguage, VoiceId[]> {
  const ready = readyVoices();
  const has = hosted()
    ? (v: VoiceId, lang: string) => hostedLanguages(v, dir()).includes(lang)
    : (v: VoiceId, lang: string) => ((BUILT_IN_VOICES as readonly string[]).includes(v) && WORKER_CLIPS.includes(lang)) || clipLanguages(v, dir()).includes(lang);
  return Object.fromEntries(SPEECH_LANGUAGE_CODES.map((lang) => [lang, ready.filter((v) => has(v, lang))])) as Record<SpeechLanguage, VoiceId[]>;
}

/** The name and the few words the form shows of each voice in each language, where they are not its own (hosted voices). */
export type VoiceNames = Partial<Record<SpeechLanguage, Partial<Record<VoiceId, { label?: string; about?: string }>>>>;
export function voiceNames(): VoiceNames {
  if (!hosted()) return {};
  return Object.fromEntries(SPEECH_LANGUAGE_CODES.map((lang) => [lang, hostedNames(lang, dir())])) as VoiceNames;
}
