import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/*
 * The voices that were designed (phase 7 spec §15): each one's reference clip, made once by the voice worker
 * from a description (`npm run make:voices -- --design`), is kept here, in the code, and sent with every line
 * that voice says. The voice worker's image holds only the two narrators; a voice kept here is spoken by any
 * deployed worker that takes a clip with a request, without building the image again.
 *
 * Node only: the browser learns which voices are ready from the server. The folder is found from this file
 * where it can be (the CLI); the web app, whose bundler gives a module no folder of its own, passes its own.
 */
export const designedDir = (): string => resolve(import.meta.dirname, "../../assets/voices");

type Library = Record<string, Record<string, string>>;

function library(dir = designedDir()): Library {
  const file = join(dir, "voices.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Library) : {};
}

/** The voices with a clip of their own here in English: the designed ones that are ready. */
export function designedVoices(dir = designedDir()): string[] {
  return Object.entries(library(dir)).filter(([id, by]) => by.en && existsSync(join(dir, `${id}.en.flac`))).map(([id]) => id);
}

/** The languages a voice has a clip of here. */
export function clipLanguages(id: string, dir = designedDir()): string[] {
  return Object.keys(library(dir)[id] ?? {}).filter((lang) => existsSync(join(dir, `${id}.${lang}.flac`)));
}

/**
 * The clip a voice speaks a line from, when it is kept here: its clip in the line's language. A voice made here
 * that has none in that language speaks from its English one; a voice of the worker's own that has none here is
 * spoken from the worker's own clip (null). So every voice speaks each language from a clip made in it, where
 * there is one, and no voice is ever spoken from a clip of another language when one in its own exists.
 */
export function designedClip(id: string, language?: string, dir = designedDir()): { audio: Buffer; text: string; sha256: string } | null {
  const by = library(dir)[id];
  if (!by) return null;
  const has = (lang: string) => !!by[lang] && existsSync(join(dir, `${id}.${lang}.flac`));
  const lang = language && has(language) ? language : has("en") ? "en" : null;
  if (!lang) return null;
  const audio = readFileSync(join(dir, `${id}.${lang}.flac`));
  return { audio, text: by[lang], sha256: createHash("sha256").update(audio).digest("hex") };
}
