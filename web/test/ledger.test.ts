import { describe, expect, it } from "vitest";
import { ledgerEntry } from "@/lib/ledger";

/* The account's history: what each row says and whether it links to a video (final review of phase 13, L1). */
describe("a row of the account's history", () => {
  it("links a job's rows to the video they paid for", () => {
    expect(ledgerEntry({ kind: "reserve", runId: "r1", reservationKind: "draft" })).toEqual({ what: "Held for a job", href: "/runs/r1" });
    expect(ledgerEntry({ kind: "settle", runId: "r1", reservationKind: "generate" })).toEqual({ what: "Job settled", href: "/runs/r1" });
  });

  it("names a topic suggestion's rows as such and links them nowhere: the request is not a video and has no page", () => {
    expect(ledgerEntry({ kind: "reserve", runId: "r2", reservationKind: "ideas" })).toEqual({ what: "Held for a topic suggestion", href: null });
    expect(ledgerEntry({ kind: "settle", runId: "r2", reservationKind: "ideas" })).toEqual({ what: "Topic suggestion settled", href: null });
  });

  it("says what other rows are, with no link when there is no run", () => {
    expect(ledgerEntry({ kind: "grant", runId: null })).toEqual({ what: "Credit added", href: null });
    expect(ledgerEntry({ kind: "plan", runId: null })).toEqual({ what: "Plan credit", href: null });
    expect(ledgerEntry({ kind: "refund", runId: null })).toEqual({ what: "Refund", href: null });
  });
});
