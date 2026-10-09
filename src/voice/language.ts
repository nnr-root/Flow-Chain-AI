/*
 * Which language a script is in, as far as the voice needs to know (phase 5 spec §6.1): a voice has a
 * reference clip per language it was recorded in, and speaks best from the one in the script's own language.
 * Only the languages the voices have clips for are told apart here; for any other, nothing is said, the voice
 * speaks from its English clip and the listener works the language out from the speech.
 */

const TURKISH_LETTERS = /[ğĞşŞıİ]/;
const TURKISH_WORDS = new Set(["ve", "bir", "bu", "için", "çok", "ile", "değil", "ama", "gibi", "daha", "kadar", "olan", "olarak", "ne", "her", "ki", "mi", "mı", "da", "de", "en", "var", "yok", "nasıl", "neden", "sonra", "önce"]);
const ENGLISH_WORDS = new Set(["the", "and", "of", "to", "in", "is", "that", "it", "was", "for", "with", "as", "on", "are", "this", "but", "not", "you", "his", "her", "they", "from", "one", "had", "what"]);

/** "tr", "en", or undefined when it is neither clearly. */
export function speechLanguage(text: string): "tr" | "en" | undefined {
  const words = text.toLocaleLowerCase("tr").split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0) return undefined;
  const count = (set: Set<string>) => words.filter((w) => set.has(w)).length;
  const [tr, en] = [count(TURKISH_WORDS), count(ENGLISH_WORDS)];
  // letters only Turkish has (among the languages a script is likely to be in) settle it, unless the text is
  // plainly English with a Turkish name in it
  if (TURKISH_LETTERS.test(text) && tr >= en) return "tr";
  if (tr > en && tr >= 2) return "tr";
  if (en > tr && en >= 2) return "en";
  return undefined;
}
