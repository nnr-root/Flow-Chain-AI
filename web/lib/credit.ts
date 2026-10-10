/*
 * Figures about credit that the pages, the server and the worker must agree on: all three read this. Its one
 * import is the pipeline's arithmetic of a video's length, which reads nothing and runs in a browser too.
 */
import { DEFAULT_SCENE_SECONDS, DEFAULT_VIDEO_SECONDS, parseDuration, parseSceneSeconds, timedScriptCost, type Timing } from "@src/duration";

/** The least a draft holds from the user's credit (the script of a short video costs about $0.006): what the shortest ones hold. */
export const DRAFT_CAP_USD = 0.02;

/** Amounts are kept to four decimals everywhere (the pipeline's ledger, the database). */
export const round4 = (usd: number): number => Math.round(usd * 10_000) / 10_000;

/** The price table's own defaults for the script's model (`Prices` in the pipeline's config; a test holds the two together). */
export const SCRIPT_RATES = { llmPerMInputTokens: 0.3, llmPerMOutputTokens: 2.5 };

/**
 * What a draft of this length holds from the user's credit: the script, were every answer it is made of sent
 * back once and bought again (an answer is paid for whether or not it is accepted), and a little over. A long
 * video's script is several answers, so it holds more; what is not used comes back when the draft is settled.
 * The worker checks a draft's reservation against this, worked out from the command it is given.
 */
export function draftCapUsd(timing: Timing = { targetSec: DEFAULT_VIDEO_SECONDS, sceneSec: DEFAULT_SCENE_SECONDS }): number {
  return Math.max(DRAFT_CAP_USD, round4(2 * timedScriptCost(SCRIPT_RATES, timing) + 0.005));
}

/** The same for a draft's command line (`--duration`, `--scene-seconds`), or NaN for one that names no length a video can have. */
export function draftCapOfArgs(args: string[]): number {
  const value = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  try {
    const duration = value("--duration");
    if (duration === undefined) return Number.NaN;
    const scene = value("--scene-seconds");
    return draftCapUsd({ targetSec: parseDuration(duration), sceneSec: scene === undefined ? DEFAULT_SCENE_SECONDS : parseSceneSeconds(scene) });
  } catch {
    return Number.NaN;
  }
}

/*
 * Credits (phase 6 spec §12). The database, the worker and the pipeline account in dollars of what a video
 * costs to make, to four decimals, as they always have. A customer is never shown those dollars: they are
 * shown credits, which are the same amount in another unit. The rate is the one place where the two meet:
 * what is sold (`billing/plans.json`: a price, and the cost it covers) and this number together decide what a
 * credit is worth to the customer and what is left for the studio.
 */

/** How many credits one dollar of a video's cost is shown as. 2,000: a credit is a twentieth of a cent of cost. */
export const CREDITS_PER_USD = 2000;

/** A cost in dollars as a whole number of credits. */
export const credits = (usd: number): number => Math.round(usd * CREDITS_PER_USD);
/** Credits back to the dollars the rest of the system counts in, to four decimals. */
export const usdOfCredits = (n: number): number => round4(n / CREDITS_PER_USD);
/** "1,250 credits", "1 credit". */
export const inCredits = (usd: number): string => {
  const n = credits(usd);
  return `${n.toLocaleString("en-US")} ${Math.abs(n) === 1 ? "credit" : "credits"}`;
};

/**
 * Whether amounts are shown as credits here. In a studio with accounts they are: its users are customers. The
 * owner's own studio without accounts shows what things cost, in dollars: that is the owner's bill. The server
 * knows which it is from its environment; the browser is told by the page (`data-credits` on the root element).
 */
export const showsCredits = (): boolean =>
  typeof document === "undefined" ? !!process.env.DATABASE_URL?.trim() : document.documentElement.dataset.credits === "1";
