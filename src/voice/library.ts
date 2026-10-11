import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS_DIR } from "../assets.js";

/*
 * The voices that were designed (phase 7 spec §15): each one's reference clip, made once by the voice worker
 * from a description (`npm run make:voices -- --design`), is kept here, in the code, and sent with every line
 * that voice says. The voice worker's image holds only the two narrators; a voice kept here is spoken by any
 * deployed worker that takes a clip with a request, without building the image again.
 *
 * Node only: the browser learns which voices are ready from the server.
 */
export const DESIGNED_DIR = join(ASSETS_DIR, "voices");

type Library = Record<string, Record<string, string>>;

function library(dir = DESIGNED_DIR): Library {
  const file = join(dir, "voices.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Library) : {};
}

/** The designed voices that have a clip, by id. */
export function designedVoices(dir = DESIGNED_DIR): string[] {
  return Object.entries(library(dir)).filter(([id, by]) => by.en && existsSync(join(dir, `${id}.en.flac`))).map(([id]) => id);
}

/**
 * A designed voice's clip for a language: its own where it has one, its English one otherwise (as the voice
 * worker does with its own voices). Null for a voice that is not a designed one.
 */
export function designedClip(id: string, language?: string, dir = DESIGNED_DIR): { audio: Buffer; text: string; sha256: string } | null {
  const by = library(dir)[id];
  if (!by) return null;
  const lang = language && by[language] && existsSync(join(dir, `${id}.${language}.flac`)) ? language : "en";
  const file = join(dir, `${id}.${lang}.flac`);
  if (!by[lang] || !existsSync(file)) return null;
  const audio = readFileSync(file);
  return { audio, text: by[lang], sha256: createHash("sha256").update(audio).digest("hex") };
}
