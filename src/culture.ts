import type { SpeechLanguage } from "./voice/language.js";

/*
 * A video in one language is made for the people who speak it (phase 8 spec §5): where its topic leaves open who is
 * in it and where, they are people of that audience, in their own places, with their own names and things. A
 * Japanese video about a nurse's night shift shows a Japanese nurse in a Japanese hospital.
 *
 * It is careful by rule, because it is easy to get wrong:
 * - Only what the topic leaves open is adapted. A real event, a real person, a historical setting, a named place,
 *   or anyone the topic itself names is never changed.
 * - People look and dress the way people there do in the video's time: no national costume, flags, landmarks or
 *   stereotypes unless the subject calls for them.
 * - Never in a video made in several languages: one set of pictures serves every version, so it belongs to none
 *   (`request.localize` is false for one, spec §4).
 * - Not in English: spoken across the world, it names no one audience.
 *
 * Each entry is who the audience is, in English, as the model reads it.
 */
export const AUDIENCE: Partial<Record<SpeechLanguage, string>> = {
  tr: "Turkey",
  es: "Spanish-speaking countries (Spain and Latin America)",
  fr: "France and the French-speaking world",
  de: "Germany, Austria and Switzerland",
  it: "Italy",
  pt: "Brazil and Portugal",
  nl: "the Netherlands and Flanders",
  pl: "Poland",
  ru: "Russian speakers",
  sv: "Sweden",
  da: "Denmark",
  no: "Norway",
  fi: "Finland",
  el: "Greece and Cyprus",
  id: "Indonesia",
  ms: "Malaysia",
  tl: "the Philippines",
  vi: "Vietnam",
  bg: "Bulgaria",
  ro: "Romania and Moldova",
  cs: "the Czech Republic",
  hr: "Croatia",
  sk: "Slovakia",
  uk: "Ukraine",
  hu: "Hungary",
  ja: "Japan",
  zh: "China",
  ko: "South Korea",
  hi: "India",
  ar: "the Arab world",
};

/** The rules a script made for one language's audience is written to (null where there is none to adapt to). */
export function cultureRules(language: SpeechLanguage | undefined): string[] | null {
  const audience = language ? AUDIENCE[language] : undefined;
  if (!audience) return null;
  return [
    `Audience: this video is made for viewers in ${audience}. Where the topic leaves open who is in it and where it happens, the people are from there: their looks, their names, their homes, streets, schools, food, money and everyday things are those of ${audience}, and styleBible.characters and styleBible.setting say so.`,
    "- Change nothing the topic decides: a real event, a real person, a period in history, a named place, or anyone the topic names stays exactly as it is. A video about ancient Rome is set in ancient Rome, whoever watches it.",
    "- People look and dress as people there really do in the video's time. No national costume, flags, famous landmarks or stereotypes unless the subject is about them; the audience should recognise their own life, not a postcard of it.",
  ];
}
