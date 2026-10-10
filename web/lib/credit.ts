/* Figures about credit that the pages, the server and the worker must agree on. No imports: all three read this. */

/** What a draft holds from the user's credit (the script costs about $0.006). The worker checks a draft's reservation against this. */
export const DRAFT_CAP_USD = 0.02;

/** Amounts are kept to four decimals everywhere (the pipeline's ledger, the database). */
export const round4 = (usd: number): number => Math.round(usd * 10_000) / 10_000;

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
