/*
 * Words, in every language a video can be in (phase 7 spec §17). Most languages set their words apart with spaces,
 * and a script's length, a caption's page and the hook's lines are all counted in words split on spaces. Chinese
 * and Japanese write no spaces: their words are found by the word segmenter that Node and every browser carry
 * (`Intl.Segmenter`), and their length is counted in characters, which is how a writer of them counts, and what a
 * model asked for "about 80 words" of Chinese cannot be relied on to understand.
 *
 * Arithmetic only: read by the CLI, the script stage, the renderer and the browser alike.
 */

/** The languages written without spaces between words. */
const UNSPACED = new Set(["zh", "ja"]);
export const isUnspaced = (language?: string): boolean => !!language && UNSPACED.has(language);

/** What a script's length is counted in, in the words a model is told it in. */
export const lengthUnit = (language?: string): "words" | "characters" => (isUnspaced(language) ? "characters" : "words");

/** A script's length: its words, or for a language without spaces its letters and digits (not its punctuation). */
export function countUnits(text: string, language?: string): number {
  if (isUnspaced(language)) return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The words of a text, as captions show them one at a time. Split on spaces, or for a language without them by
 * the segmenter, with the punctuation that follows a word kept on it (so a page still ends after a full stop).
 */
export function splitWords(text: string, language?: string): string[] {
  if (!isUnspaced(language)) return text.trim().split(/\s+/).filter(Boolean);
  const words: string[] = [];
  for (const s of new Intl.Segmenter(language, { granularity: "word" }).segment(text)) {
    if (!s.segment.trim()) continue;
    if (!s.isWordLike && words.length > 0) words[words.length - 1] += s.segment.trim();
    else words.push(s.segment.trim());
  }
  return words;
}

/** What goes between two words in a caption or a title: a space, or nothing in a language without spaces. */
export const wordJoiner = (language?: string): string => (isUnspaced(language) ? "" : " ");

/** The languages written right to left. */
const RIGHT_TO_LEFT = new Set(["ar"]);
export const isRightToLeft = (language?: string): boolean => !!language && RIGHT_TO_LEFT.has(language);

/**
 * How many of a language's units say as much as one English word, for the limits written in words (a scene's
 * narration, the hook). Spaced languages keep the limits as they are; in a language without spaces one word is a
 * few characters, by how many of them its voice says in the time an English word takes (`rate` against 2.4).
 */
export function unitsPerWord(language: string | undefined, rate: number): number {
  return isUnspaced(language) ? rate / 2.4 : 1;
}

/** The most a hook may have: six words, or the characters that say as much in a language without spaces. */
export const hookCap = (language: string | undefined, rate: number): number => Math.round(6 * unitsPerWord(language, rate));
