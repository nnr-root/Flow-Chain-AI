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
