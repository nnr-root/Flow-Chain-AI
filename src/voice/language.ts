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

/**
 * The languages a video can be asked for in (phase 7 spec §14), each by its own name. A language is here when
 * all of this holds for it:
 * - the voice model speaks it (its makers list thirty languages);
 * - its words are set apart by spaces, which is how a script's length is counted and how captions are laid over
 *   what was heard, one word at a time;
 * - a caption typeface the studio ships has its letters (`fontCovers` below).
 * That leaves out the model's other ten: Arabic and Hebrew (written right to left), Hindi, Thai, Burmese,
 * Khmer and Lao (no typeface here has their letters, and most write no spaces), Chinese and Japanese (no
 * spaces), Korean (no typeface). Each is a piece of work of its own, not a line in this list.
 *
 * A voice speaks a language from its own reference clip where it has one (English and Turkish) and from its
 * English clip otherwise; the voice worker has always done so.
 */
export const SPEECH_LANGUAGES = {
  en: "English", tr: "Türkçe", es: "Español", fr: "Français", de: "Deutsch", it: "Italiano", pt: "Português",
  nl: "Nederlands", pl: "Polski", ru: "Русский", sv: "Svenska", da: "Dansk", no: "Norsk", fi: "Suomi",
  el: "Ελληνικά", id: "Bahasa Indonesia", ms: "Bahasa Melayu", tl: "Tagalog", sw: "Kiswahili", vi: "Tiếng Việt",
} as const;
export type SpeechLanguage = keyof typeof SPEECH_LANGUAGES;
export const SPEECH_LANGUAGE_CODES = Object.keys(SPEECH_LANGUAGES) as [SpeechLanguage, ...SpeechLanguage[]];

/** How a script's model is told the language: its English name. */
export const LANGUAGE_IN_ENGLISH: Record<SpeechLanguage, string> = {
  en: "English", tr: "Turkish", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", ru: "Russian", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish",
  el: "Greek", id: "Indonesian", ms: "Malay", tl: "Tagalog (Filipino)", sw: "Swahili", vi: "Vietnamese",
};

/**
 * The languages whose letters a shipped caption typeface does not have, by its file (read from the files'
 * own character maps on 2026-10-10). A caption set in a face without a language's letters shows those letters
 * in whatever the renderer falls back to, mixed in with the rest: a video in such a language is given a face
 * that has them all instead (`captionStyleFor`). A face not listed here (a brand's own) is taken as it is.
 */
const FONT_LACKS: Record<string, readonly SpeechLanguage[]> = {
  "Montserrat-ExtraBold.ttf": ["el"],
  "Inter-SemiBold.ttf": [],
  "Bangers-Regular.ttf": ["ru", "el"],
  "Cinzel-Variable.ttf": ["vi", "ru", "el"],
  "LuckiestGuy-Regular.ttf": ["vi", "ru", "el"],
  "Orbitron-Variable.ttf": ["tr", "pl", "sv", "da", "no", "vi", "ru", "el"],
};
export const fontCovers = (file: string, language: SpeechLanguage): boolean => !(FONT_LACKS[file] ?? []).includes(language);

/**
 * The studio's own voices, by the id the voice worker knows them by (a test holds this list to the worker's own
 * files). `label`: what a person is shown. `suits`: the videos the voice was made for. The two narrators are
 * plain, even voices for anything; the others were each designed from a description of who speaks and how
 * (`scripts/design-voices.py`), and what is said of them here is what was asked for: how one sounds is for the
 * person to hear in its sample.
 */
export const VOICES = {
  "narrator-m": { label: "Narrator (male)", suits: "A plain, even voice for any video" },
  "narrator-f": { label: "Narrator (female)", suits: "A plain, even voice for any video" },
  storyteller: { label: "Storyteller", suits: "Fables, history, legends and stories told slowly" },
  documentary: { label: "Documentary", suits: "Nature, science and history that want some weight" },
  trailer: { label: "Trailer", suits: "True crime, horror, epics and anything dramatic" },
  host: { label: "Host", suits: "Fast facts, countdowns, tech and anything with energy" },
  explainer: { label: "Explainer", suits: "How-to, money, business and step-by-step guides" },
  anchor: { label: "Anchor", suits: "News, reports and facts told straight" },
  upbeat: { label: "Upbeat", suits: "Fun facts, food, lifestyle and light-hearted videos" },
  calm: { label: "Calm", suits: "Wellness, sleep, nature and gentle stories" },
  mystery: { label: "Mystery", suits: "Unsolved cases, secrets and the strange" },
  storybook: { label: "Storybook", suits: "Children's stories, fables and cartoons" },
} as const;
export type VoiceId = keyof typeof VOICES;

/** The voices the voice worker's image has. Every other voice is a designed one, whose clip goes with each line. */
export const BUILT_IN_VOICES: readonly VoiceId[] = ["narrator-m", "narrator-f"];

/**
 * How each designed voice was asked for: who speaks, the colour of the voice, the mood and the pace (the voice
 * model takes gender, age, tone, emotion and pace). Read by `npm run make:voices -- --design`.
 */
export const VOICE_DESIGNS: Partial<Record<VoiceId, string>> = {
  storyteller: "An older man in his sixties, warm, deep and slightly gravelly voice, kind and calm, slow unhurried pace, like a grandfather telling a story by the fire",
  documentary: "A middle-aged man, deep, rich and authoritative voice, serious and composed, measured steady pace, like a nature documentary narrator",
  trailer: "A man with a very low, dark and intense voice, dramatic and gripping, slow heavy pace, like a movie trailer voice-over",
  host: "A young man in his twenties, bright, energetic and excited voice, smiling and enthusiastic, fast lively pace, like an online video host",
  explainer: "A man in his thirties, friendly, clear and conversational voice, relaxed and approachable, medium pace, like a teacher explaining something simply",
  anchor: "A woman in her thirties, clear, crisp and confident voice, poised and professional, brisk even pace, like a television news anchor",
  upbeat: "A young woman in her twenties, cheerful, bright and playful voice, smiling and bubbly, quick upbeat pace",
  calm: "A woman with a soft, soothing and gentle voice, peaceful and tender, slow relaxed pace, like a guided meditation",
  mystery: "A woman with a low, hushed and mysterious voice, secretive and suspenseful, slow deliberate pace, almost a whisper",
  storybook: "A young woman with a bright, animated and expressive voice, warm and full of wonder, lively pace, like someone reading a picture book to children",
};

