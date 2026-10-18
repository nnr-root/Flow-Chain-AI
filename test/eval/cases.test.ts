import { describe, expect, it } from "vitest";
import { CASES } from "../../src/eval/cases.js";
import { SINGLE_ANSWER_MAX_SECONDS } from "../../src/duration.js";
import { editById } from "../../src/edits.js";
import { formatById, formatClash } from "../../src/formats.js";
import { nicheById } from "../../src/niches.js";

describe("the eval cases", () => {
  it("each have their own id", () => expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length));

  it("only name a niche, a type and an edit the studio has, and never a type its niche forbids", () => {
    for (const { id, request: r } of CASES) {
      if (r.niche) expect(nicheById(r.niche), id).toBeDefined();
      if (r.format) expect(formatById(r.format), id).toBeDefined();
      if (r.edit) expect(editById(r.edit), id).toBeDefined();
      if (r.format && r.niche) expect(formatClash(r.format, nicheById(r.niche)!.kind), id).toBeNull();
    }
  });

  it("cover what the audit is about: Chinese, Japanese, Arabic, a long video in parts, a translation, a period, an animal, an instruction in the topic", () => {
    const ids = CASES.map((c) => c.id);
    for (const id of ["lang-zh", "lang-ja", "lang-ar", "parts-120", "translate-de", "period-constantinople", "animal-falcon", "injection-topic"]) expect(ids, id).toContain(id);
    expect(CASES.find((c) => c.id === "parts-120")!.request.timing!.targetSec).toBeGreaterThan(SINGLE_ANSWER_MAX_SECONDS);
  });

  it("have a translation whose scenes and seconds agree", () => {
    const ask = CASES.find((c) => c.id === "translate-de")!.request.ask;
    if (ask?.kind !== "translate") throw new Error("not a translation");
    expect(ask.seconds).toHaveLength(ask.source.narrations.length);
  });
});
