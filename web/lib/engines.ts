import { inCredits } from "./credit";

/*
 * What makes each part of a video is the studio's own business (phase 5 spec §7, and §9.17 for the owner's
 * ruling that it is given no name at all): the models and the companies behind them can change without
 * anything a customer sees changing, and no page, published file or API answer names them. A customer is told
 * what a video costs and what it will look like, not what made it.
 */

/**
 * What a studio with accounts says in place of the names of settings that are not set: which key the owner has
 * yet to fill in is the owner's to know (the local studio, which is the owner's, lists them).
 */
export const NOT_READY = "not_ready";

/**
 * What the pages do not say about themselves either: a brand name for a part of the pipeline, "our engine",
 * models "we" use or rent. `web/test/names.test.ts` holds the source of every page and component to it.
 */
export const SELF_NAMES: RegExp[] = [/flow\s?chain (voice|picture|motion)/i, /\b(our|its) (own )?(engines?|models?)\b/i, /\bmodels? we\b/i, /\b(picture|voice|clip|video) (engine|model)s?\b/i];

/**
 * Names that belong to how the studio is built: models, the companies that make or host them, the settings that
 * hold their keys. `web/test/names.test.ts` holds every published file and every customer-facing answer to it.
 * (Stripe is not here: a customer pays there and is told so. Other video tools' names in the dated price
 * comparison are not here either.)
 */
export const INTERNAL_NAMES: RegExp[] = [
  /gemini/i, /eleven\s?labs/i, /\bfal(\.ai|-ai)?\b/i, /run\s?pod/i, /comfy\s?ui/i, /hugging\s?face/i,
  /\bsdxl\b/i, /stable diffusion/i, /realvis/i, /animagine/i, /ip-?adapter/i, /\bwan\s?2/i, /\bwan22/i, /kling/i, /\bflux\b/i, /klein/i, /qwen/i,
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
    // (a dollar amount is what a step cost the studio: a customer is shown it in credits, like every other amount)
    const shown = namesInternals(line)
      ? "(a step reported; the details are kept with the studio)"
      : line.replace(/\$(\d+(?:\.\d+)?)/g, (_whole, usd: string) => inCredits(Number(usd)));
    if (shown !== out.at(-1)) out.push(shown);
  }
  return out;
}
