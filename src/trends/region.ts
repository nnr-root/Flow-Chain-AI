/** The region whose chart a language's viewers are best matched by (phase 13 spec §2). Keys are the studio's own `SPEECH_LANGUAGES`. */
const REGION: Record<string, string> = {
  en: "US", tr: "TR", es: "ES", fr: "FR", de: "DE", it: "IT", pt: "BR", nl: "NL", pl: "PL", ru: "RU", sv: "SE", da: "DK",
  no: "NO", fi: "FI", el: "GR", id: "ID", ms: "MY", tl: "PH", vi: "VN", bg: "BG", ro: "RO", cs: "CZ", hr: "HR", sk: "SK",
  uk: "UA", hu: "HU", ja: "JP", zh: "TW", ko: "KR", hi: "IN", ar: "SA",
};

export const REGION_LANGUAGES: readonly string[] = Object.keys(REGION);

/** An explicit two-letter code wins (upper-cased); otherwise the language's usual region; otherwise the United States. */
export function regionFor(language: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!/^[A-Za-z]{2}$/.test(explicit)) throw new Error("a region is two letters");
    return explicit.toUpperCase();
  }
  return REGION[language] ?? "US";
}
