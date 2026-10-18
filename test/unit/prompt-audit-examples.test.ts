import { describe, expect, it } from "vitest";
import { NICHES, nicheById } from "../../src/niches.js";

// (src/niches.ts leaves health and medicine out on purpose; an example is a topic the form offers and the model reads)
const BODY = /\b(sleep|diet|disease|sick|illness|medicine|drugs?|vaccines?|cancer|surgery|health)\b/i;

describe("the niches' example topics", () => {
  it("offer none about the body or health, which the niches leave out on purpose", () => {
    for (const n of NICHES) for (const x of n.examples) expect(x, n.id).not.toMatch(BODY);
  });
});

describe("the made-up stories' example topics", () => {
  it("offer no tale that is commonly told as a people's legend without a source for it", () => {
    // "The two wolves inside you" is told as a Cherokee legend; no Cherokee source for it is documented, and a story
    // niche carries no FACT_RULES to stop "a Cherokee elder told his grandson" (phase 9 spec §2.1, row 16)
    expect(nicheById("life-stories")!.examples.join(" ")).not.toMatch(/two wolves/i);
  });
});
