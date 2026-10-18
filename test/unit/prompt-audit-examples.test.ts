import { describe, expect, it } from "vitest";
import { NICHES } from "../../src/niches.js";

// (src/niches.ts leaves health and medicine out on purpose; an example is a topic the form offers and the model reads)
const BODY = /\b(sleep|diet|disease|sick|illness|medicine|drugs?|vaccines?|cancer|surgery|health)\b/i;

describe("the niches' example topics", () => {
  it("offer none about the body or health, which the niches leave out on purpose", () => {
    for (const n of NICHES) for (const x of n.examples) expect(x, n.id).not.toMatch(BODY);
  });
});
