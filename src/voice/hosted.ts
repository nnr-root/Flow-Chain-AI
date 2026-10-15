import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { designedDir } from "./library.js";

/*
 * Which hosted voice says each of the studio's voices, language by language (phase 5 spec §11). The studio's
 * voices (`VOICES`: Storyteller, Host…) are roles; here each is given a voice of the hosted service's in each
 * language one was chosen for, a voice whose own language that is, so nobody speaks Turkish in an English
 * accent. A role with no voice chosen in a language speaks it in its English voice, and the form says so.
 *
 * The file is the owner's to edit (`assets/voices/elevenlabs.json`), and is filled by `npm run make:voices --
 * --hosted …`. Node only: the web app passes its own folder, as for the designed clips.
 */

const Entry = z.strictObject({
  /** The hosted service's id of the voice. */
  id: z.string().regex(/^[A-Za-z0-9]{8,40}$/),
  /** Its name there: for the owner, never shown to a customer. */
  name: z.string().min(1).max(80),
  /** What the form calls it: a first name, as voices are known by (phase 5 spec §11.5). Unique in its language. */
  label: z.string().min(1).max(24).optional(),
  /** Who it sounds like, in a few words ("Male, British, middle-aged"). */
  about: z.string().min(1).max(60).optional(),
});
const Catalogue = z.strictObject({
  voices: z.record(z.string(), z.record(z.string().regex(/^[a-z]{2}$/), Entry)),
});
export type HostedCatalogue = z.infer<typeof Catalogue>;

export const HOSTED_FILE = "elevenlabs.json";

export function hostedCatalogue(dir = designedDir()): HostedCatalogue {
  const file = join(dir, HOSTED_FILE);
  return existsSync(file) ? Catalogue.parse(JSON.parse(readFileSync(file, "utf8"))) : { voices: {} };
}

/** What the form shows of each voice in a language: its name and who it sounds like, where the catalogue says. */
export function hostedNames(language: string, dir = designedDir()): Record<string, { label?: string; about?: string }> {
  return Object.fromEntries(
    Object.entries(hostedCatalogue(dir).voices).flatMap(([role, by]) => (by[language] ? [[role, { label: by[language].label, about: by[language].about }]] : [])),
  );
}

/** The roles that have a hosted voice in English: the ones a run spoken by the hosted service can be asked for. */
export function hostedRoles(dir = designedDir()): string[] {
  return Object.entries(hostedCatalogue(dir).voices).filter(([, by]) => by.en).map(([role]) => role);
}

/** The languages a role has a voice of its own chosen in. */
export function hostedLanguages(role: string, dir = designedDir()): string[] {
  return Object.keys(hostedCatalogue(dir).voices[role] ?? {});
}

/**
 * The hosted voice that says a role's line in a language: the one chosen for that language, else its English one.
 * Null for anything that is not a role here, which a run made before the catalogue names (its voice id was the
 * service's own) and which is then sent as it is.
 */
export function hostedVoice(role: string, language?: string, dir = designedDir()): string | null {
  const by = hostedCatalogue(dir).voices[role];
  if (!by) return null;
  return (language && by[language]?.id) || by.en?.id || null;
}

/**
 * The languages each of the hosted service's models speaks, by the studio's codes (read from its /v1/models on
 * 2026-10-12; Filipino is "fil" there, "tl" here). The default model speaks twenty-nine; Norwegian, Vietnamese and
 * Hungarian are spoken only by the 2.5 models, which are also told the language.
 */
const MODEL_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  eleven_v3: ["af", "ar", "hy", "as", "az", "be", "bn", "bs", "bg", "ca", "ceb", "ny", "hr", "cs", "da", "nl", "en", "et", "tl", "fi", "fr", "gl", "ka", "de", "el", "gu", "ha", "he", "hi", "hu", "is", "id", "ga", "it", "ja", "jv", "kn", "kk", "ky", "ko", "lv", "ln", "lt", "lb", "mk", "ms", "ml", "zh", "mr", "ne", "no", "ps", "fa", "pl", "pt", "pa", "ro", "ru", "sr", "sd", "sk", "sl", "so", "es", "sw", "sv", "ta", "te", "th", "tr", "uk", "ur", "vi", "cy"],
  eleven_multilingual_v2: ["en", "ja", "zh", "de", "hi", "fr", "ko", "pt", "it", "es", "id", "nl", "tr", "tl", "pl", "sv", "bg", "ro", "ar", "cs", "el", "fi", "hr", "ms", "sk", "da", "ta", "uk", "ru"],
  eleven_flash_v2_5: ["en", "ja", "zh", "de", "hi", "fr", "ko", "pt", "it", "es", "ru", "id", "nl", "tr", "tl", "pl", "sv", "bg", "ro", "ar", "cs", "el", "fi", "hr", "ms", "sk", "da", "ta", "uk", "hu", "no", "vi"],
  eleven_turbo_v2_5: ["en", "ja", "zh", "de", "hi", "fr", "ko", "pt", "it", "es", "ru", "id", "nl", "tr", "tl", "pl", "sv", "bg", "ro", "ar", "cs", "el", "fi", "hr", "ms", "sk", "da", "ta", "uk", "vi", "no", "hu"],
};
/** Where a language the chosen model does not speak is sent: the model of the same family that does. */
const SPEAKS_MORE = ["eleven_turbo_v2_5", "eleven_flash_v2_5"];

/**
 * The model a new run in a language is frozen with: the one chosen (`ELEVENLABS_MODEL`) where it speaks the
 * language, else the first of the 2.5 models that does. A language none of them speaks is refused, rather than
 * read out by a model guessing at it. A model this list does not know is taken at its word.
 */
export function hostedModelFor(language: string | undefined, chosen: string): string {
  const speaks = (model: string) => MODEL_LANGUAGES[model]?.includes(language ?? "en") ?? true;
  if (!language || speaks(chosen)) return chosen;
  const other = SPEAKS_MORE.find((m) => MODEL_LANGUAGES[m].includes(language));
  if (!other) throw new Error(`no voice model speaks "${language}"`);
  return other;
}
