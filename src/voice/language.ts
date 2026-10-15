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
 * The languages a video can be asked for in (phase 7 spec §14, §17), each by its own name. A language is here when
 * the hosted voice has voices native to it in numbers (phase 5 spec §11: hundreds in each of these; Swahili, with
 * ten and none professional, was taken out on the owner's word), its model speaks it (`hostedModelFor`), and a
 * caption typeface the studio ships has its letters (`fontCovers`, and the script faces in `SCRIPT_FACES`).
 * Chinese and Japanese write no spaces and Arabic is written right to left: `words.ts` and the caption layer
 * handle both. The studio's own voice speaks the first nineteen (`OWN_VOICE_LANGUAGES`); the others are offered
 * only with the hosted voice.
 */
export const SPEECH_LANGUAGES = {
  en: "English", tr: "Türkçe", es: "Español", fr: "Français", de: "Deutsch", it: "Italiano", pt: "Português",
  nl: "Nederlands", pl: "Polski", ru: "Русский", sv: "Svenska", da: "Dansk", no: "Norsk", fi: "Suomi",
  el: "Ελληνικά", id: "Bahasa Indonesia", ms: "Bahasa Melayu", tl: "Tagalog", vi: "Tiếng Việt",
  bg: "Български", ro: "Română", cs: "Čeština", hr: "Hrvatski", sk: "Slovenčina", uk: "Українська", hu: "Magyar",
  ja: "日本語", zh: "中文", ko: "한국어", hi: "हिन्दी", ar: "العربية",
} as const;
export type SpeechLanguage = keyof typeof SPEECH_LANGUAGES;
export const SPEECH_LANGUAGE_CODES = Object.keys(SPEECH_LANGUAGES) as [SpeechLanguage, ...SpeechLanguage[]];

/** The languages the studio's own voice speaks (phase 7 spec §14): without the hosted voice, only these are offered. */
export const OWN_VOICE_LANGUAGES: readonly SpeechLanguage[] = ["en", "tr", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "sv", "da", "no", "fi", "el", "id", "ms", "tl", "vi"];

/** How a script's model is told the language: its English name. */
export const LANGUAGE_IN_ENGLISH: Record<SpeechLanguage, string> = {
  en: "English", tr: "Turkish", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", ru: "Russian", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish",
  el: "Greek", id: "Indonesian", ms: "Malay", tl: "Tagalog (Filipino)", vi: "Vietnamese",
  bg: "Bulgarian", ro: "Romanian", cs: "Czech", hr: "Croatian", sk: "Slovak", uk: "Ukrainian", hu: "Hungarian",
  ja: "Japanese", zh: "Chinese (Mandarin, in simplified characters)", ko: "Korean", hi: "Hindi (in Devanagari)", ar: "Arabic (Modern Standard)",
};

/**
 * The languages whose letters a shipped caption typeface does not have, by its file (read from the files'
 * own character maps on 2026-10-12, with each language's alphabet and its sample line in both cases). A caption set in a face without a language's letters shows those letters
 * in whatever the renderer falls back to, mixed in with the rest: a video in such a language is given a face
 * that has them all instead (`captionStyleFor`). A face not listed here (a brand's own) is taken as it is.
 */
const FONT_LACKS: Record<string, readonly SpeechLanguage[]> = {
  "Montserrat-ExtraBold.ttf": ["el", "ja", "zh", "ko", "hi", "ar"],
  "Inter-SemiBold.ttf": ["ja", "zh", "ko", "hi", "ar"],
  "Bangers-Regular.ttf": ["ru", "el", "bg", "uk", "ja", "zh", "ko", "hi", "ar"],
  "Cinzel-Variable.ttf": ["ru", "el", "vi", "bg", "uk", "ja", "zh", "ko", "hi", "ar"],
  "LuckiestGuy-Regular.ttf": ["ru", "el", "vi", "bg", "ro", "uk", "ja", "zh", "ko", "hi", "ar"],
  "Orbitron-Variable.ttf": ["tr", "pl", "ru", "da", "no", "el", "vi", "bg", "ro", "cs", "hr", "sk", "uk", "hu", "ja", "zh", "ko", "hi", "ar"],
  "NotoSansJP-ExtraBold.ttf": ["tr", "fr", "pl", "el", "ro", "cs", "hr", "sk", "uk", "hu", "zh", "ko", "hi", "ar"],
  "NotoSansSC-ExtraBold.ttf": ["tr", "fr", "pl", "el", "ro", "cs", "hr", "sk", "uk", "hu", "ko", "hi", "ar"],
  "NotoSansKR-ExtraBold.ttf": ["tr", "fr", "pl", "el", "ro", "cs", "hr", "sk", "uk", "hu", "ja", "zh", "hi", "ar"],
  "NotoSansDevanagari-ExtraBold.ttf": ["ru", "el", "vi", "bg", "uk", "ja", "zh", "ko", "ar"],
  "NotoSansArabic-ExtraBold.ttf": ["ru", "el", "vi", "bg", "uk", "ja", "zh", "ko", "hi"],
};
export const fontCovers = (file: string, language: SpeechLanguage): boolean => !(FONT_LACKS[file] ?? []).includes(language);

/**
 * The studio's own voices, by the id the voice worker knows them by (a test holds this list to the worker's own
 * files). `label`: what a person is shown. `suits`: the videos the voice was made for. `pace`: how fast it speaks
 * against the narrators, from its samples in the languages it has them in (absent: within a twentieth of them),
 * which are the hosted voice's since phase 5 spec §11 (the own voice's paces were not kept: they are for its fallback); a script
 * for a slower voice is asked for fewer words, or its video would run long (phase 7 spec §15). The two narrators are
 * plain, even voices for anything; the others were each designed from a description of who speaks and how
 * (`scripts/design-voices.py`), and what is said of them here is what was asked for: how one sounds is for the
 * person to hear in its sample.
 */
const OWN_VOICES = {
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
  mystery: { label: "Mystery", suits: "Unsolved cases, secrets and the strange", pace: 0.95 },
  storybook: { label: "Storybook", suits: "Children's stories, fables and cartoons", pace: 0.93 },
} as const;

/**
 * The hosted voice's own best-known voices (phase 5 spec §11.5), offered by their names in English once each is in
 * the catalogue (`assets/voices/elevenlabs.json`). The studio's own voice has no clip of them: without the hosted
 * voice they are not offered. `suits` is what each was made for, in the studio's words.
 */
const HOSTED_ONLY_VOICES = {
  adam: { label: "Adam", suits: "Firm and bright: motivation, bold facts and ads" },
  brian: { label: "Brian", suits: "Deep and comforting: narration and documentaries" },
  george: { label: "George", suits: "A warm British storyteller: stories and history" },
  bill: { label: "Bill", suits: "Wise and mature: stories, history and life lessons", pace: 0.77 },
  daniel: { label: "Daniel", suits: "A steady British broadcaster: news and reports", pace: 0.89 },
  eric: { label: "Eric", suits: "Smooth and trustworthy: business and money", pace: 1.13 },
  roger: { label: "Roger", suits: "Laid-back and resonant: casual talk and podcasts", pace: 1.05 },
  chris: { label: "Chris", suits: "Down to earth: reviews, vlogs and everyday stories", pace: 1.12 },
  will: { label: "Will", suits: "A relaxed optimist: easygoing, friendly videos" },
  liam: { label: "Liam", suits: "Young and energetic: social media and tech" },
  charlie: { label: "Charlie", suits: "Confident and Australian: energetic facts and sport", pace: 0.92 },
  callum: { label: "Callum", suits: "Gravelly, with an edge: mystery, villains and games", pace: 0.89 },
  harry: { label: "Harry", suits: "Fierce and animated: action, battles and games" },
  river: { label: "River", suits: "Relaxed and neutral: anything informative", pace: 1.05 },
  sarah: { label: "Sarah", suits: "Confident and warm: explainers and news" },
  alice: { label: "Alice", suits: "A clear British educator: how-to and learning", pace: 0.89 },
  matilda: { label: "Matilda", suits: "A professional alto: business and explainers" },
  bella: { label: "Bella", suits: "Bright and professional: education and ads" },
  lily: { label: "Lily", suits: "Velvety and British: drama and narration", pace: 0.93 },
  jessica: { label: "Jessica", suits: "Playful and bright: fun facts, trends and lifestyle" },
  laura: { label: "Laura", suits: "Sunny and quirky: lifestyle and light-hearted videos" },
} as const;

export const VOICES = { ...OWN_VOICES, ...HOSTED_ONLY_VOICES } as const;
/** The hosted voice's best-known voices: the form shows them apart from the studio's own, under their own heading. */
export const WELL_KNOWN_VOICE_IDS = Object.keys(HOSTED_ONLY_VOICES) as Array<keyof typeof HOSTED_ONLY_VOICES>;
/** The voices the studio's own voice can speak: the ones it has, or can design, a clip of. */
export type OwnVoiceId = keyof typeof OWN_VOICES;
export const OWN_VOICE_IDS = Object.keys(OWN_VOICES) as OwnVoiceId[];
export type VoiceId = keyof typeof VOICES;

/** The voices the voice worker's image has clips of (English and Turkish). Every other clip goes with each line. */
export const BUILT_IN_VOICES: readonly OwnVoiceId[] = ["narrator-m", "narrator-f"];

/**
 * How each voice is asked for (phase 7 spec §16): its sex, and in words who speaks, the colour of the voice, the
 * mood and the pace. Every voice is made in every language from this, speaking that language natively: a voice
 * made in English and made to speak Turkish speaks it with an English accent ("hör" for "her"). The narrators'
 * English and Turkish clips are the worker's own; their other languages are made the same way.
 *
 * The descriptions differ in what makes voices different, not only in mood: sex, age, pitch, and the grain of
 * the voice. Ten voices described by mood alone came out as three or four voices in different moods (§15.1).
 */
export const VOICE_DESIGNS: Record<OwnVoiceId, { sex: "m" | "f"; description: string }> = {
  "narrator-m": { sex: "m", description: "A man in his forties with a clear, pleasant mid-range voice, neutral and even, calm, medium pace" },
  "narrator-f": { sex: "f", description: "A woman in her thirties with a clear, pleasant mid-range voice, neutral and even, calm, medium pace" },
  storyteller: { sex: "m", description: "An old man in his seventies with a raspy, gravelly, weathered voice, kind and warm, slow and unhurried, like a grandfather by the fire" },
  documentary: { sex: "m", description: "A man in his fifties with a deep, smooth and resonant baritone voice, rich and polished, serious and measured, steady pace" },
  trailer: { sex: "m", description: "A man with an extremely deep, booming bass voice, dark, powerful and dramatic, slow heavy pace, like a movie trailer" },
  host: { sex: "m", description: "A man in his thirties with a deep, low-pitched male voice, loud and energetic, enthusiastic and punchy, fast pace, like a radio host" },
  mystery: { sex: "m", description: "A man in his thirties with a husky, breathy, hushed voice, close to a whisper, secretive and suspenseful, slow pace" },
  explainer: { sex: "f", description: "A woman in her thirties with a warm, rounded low alto voice, friendly and patient, conversational, medium pace" },
  anchor: { sex: "f", description: "A woman in her late forties with a firm, crisp and slightly low voice, authoritative and poised, brisk precise pace" },
  upbeat: { sex: "f", description: "A teenage girl of about seventeen with a high, bright and bubbly voice, giggly and cheerful, quick pace" },
  calm: { sex: "f", description: "A woman in her fifties with a soft, low, breathy and velvety voice, soothing and tender, very slow pace" },
  storybook: { sex: "f", description: "A young woman with a very high, sing-song, cartoon-like voice, wide-eyed and theatrical, playful, lively pace" },
};

/** How fast a voice speaks against the narrators (1 for the narrators and any voice not on the list). */
export function voicePace(voice?: string): number {
  const v = voice ? (VOICES as Record<string, { pace?: number }>)[voice] : undefined;
  return v?.pace ?? 1;
}

