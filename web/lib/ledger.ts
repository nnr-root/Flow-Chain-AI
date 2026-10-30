/** What a row of the account's history says, and where it links (shared by the page and its test; no imports). */
export type LedgerKind = "grant" | "reserve" | "settle" | "purchase" | "plan" | "expire" | "refund";

const WHAT: Record<LedgerKind, string> = {
  grant: "Credit added", reserve: "Held for a job", settle: "Job settled",
  purchase: "Top-up bought", plan: "Plan credit", expire: "Plan credit expired", refund: "Refund",
};
/** A topic suggestion (phase 13) is a hidden request, not a video: it has no page to link to. */
const IDEAS_WHAT: Partial<Record<LedgerKind, string>> = { reserve: "Held for a topic suggestion", settle: "Topic suggestion settled" };

/**
 * The words for a row and the video it links to, if any. Whether a row is a topic suggestion's is told by the kind of
 * the reservation it belongs to (a settle row's note is "charged X of Y", so the note cannot tell).
 */
export function ledgerEntry(row: { kind: LedgerKind; runId: string | null; reservationKind?: string | null }): { what: string; href: string | null } {
  if (row.reservationKind === "ideas") return { what: IDEAS_WHAT[row.kind] ?? WHAT[row.kind], href: null };
  return { what: WHAT[row.kind], href: row.runId ? `/runs/${row.runId}` : null };
}
