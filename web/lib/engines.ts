/*
 * What customers are told makes each part of a video (phase 5 spec §7). The models and the companies behind
 * them are the studio's own business: they can change without anything a customer sees changing, and no page,
 * published file or API answer names them. Nothing here claims more than a name: the copy says "our engine",
 * never that a model was built or trained by the studio.
 */
export const ENGINES = {
  voice: "FlowChain Voice",
  pictures: "FlowChain Picture",
  clips: "FlowChain Motion",
} as const;

/**
 * What a studio with accounts says in place of the names of settings that are not set: which key the owner has
 * yet to fill in is the owner's to know (the local studio, which is the owner's, lists them).
 */
export const NOT_READY = "not_ready";

/** The engine behind a receipt's line, where it has one (the script has no name of its own). */
export const ENGINE_OF_LINE: Record<string, string | undefined> = { Voice: ENGINES.voice, Pictures: ENGINES.pictures, Clips: ENGINES.clips };

/**
 * Names that belong to how the studio is built: models, the companies that make or host them, the settings that
 * hold their keys. `web/test/names.test.ts` holds every published file and every customer-facing answer to it.
 * (Stripe is not here: a customer pays there and is told so. Other video tools' names in the dated price
 * comparison are not here either.)
 */
export const INTERNAL_NAMES: RegExp[] = [
  /gemini/i, /eleven\s?labs/i, /\bfal(\.ai|-ai)?\b/i, /run\s?pod/i, /comfy\s?ui/i, /hugging\s?face/i,
  /\bsdxl\b/i, /stable diffusion/i, /realvis/i, /animagine/i, /ip-?adapter/i, /\bwan\s?2/i, /\bwan22/i, /kling/i, /\bflux\b/i,
  /voxcpm/i, /chatterbox/i, /whisper/i, /supabase/i, /cloudflare/i, /\bR2_/, /_API_KEY\b/, /_ENDPOINT\b/, /_VOICE_ID\b/,
];

export const namesInternals = (text: string): boolean => INTERNAL_NAMES.some((name) => name.test(text));

/**
 * A job's output as a customer may read it. The pipeline's own words are kept where they say nothing about how
 * it is built; a line that names a model, a provider or a setting is replaced by one that says only that
 * something went on, because half a sentence with the name cut out explains nothing and can still give it away.
 */
export function publicLog(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const shown = namesInternals(line) ? "(a step of the engine reported; the details are kept with the studio)" : line;
    if (shown !== out.at(-1)) out.push(shown);
  }
  return out;
}
