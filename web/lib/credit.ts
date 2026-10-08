/* Figures about credit that the pages, the server and the worker must agree on. No imports: all three read this. */

/** What a draft holds from the user's credit (the script costs about $0.006). The worker checks a draft's reservation against this. */
export const DRAFT_CAP_USD = 0.02;

/** Amounts are kept to four decimals everywhere (the pipeline's ledger, the database). */
export const round4 = (usd: number): number => Math.round(usd * 10_000) / 10_000;
