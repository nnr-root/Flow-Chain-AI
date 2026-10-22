import { describe, expect, it } from "vitest";
import { inspectPrompt } from "../../src/providers/gemini.js";
import { Verdict } from "../../src/stages/inspect.js";

describe("the look at a picture", () => {
  it("also looks for what was copied from a reference, and says which pictures are references", () => {
    const p = inspectPrompt({ images: ["a.png"], expected: "a lighthouse", references: ["r1.png", "r2.png"] });
    expect(p).toContain("copied from a reference");
    expect(p).toContain("last 2 pictures");
  });
  it("does not mention references where there are none", () => {
    expect(inspectPrompt({ images: ["a.png"], expected: "a lighthouse" })).not.toContain("reference");
  });
  it("looks for unlawful, unsafe or infringing content only when asked", () => {
    expect(inspectPrompt({ images: ["a.png"], expected: "x", checkContent: true })).toContain("unlawful, unsafe or infringing");
    expect(inspectPrompt({ images: ["a.png"], expected: "x" })).not.toContain("unlawful");
  });
  it("reads an answer without the new field as safe", () => {
    expect(Verdict.parse({ ok: true, problems: [] }).unsafe).toBe(false);
    expect(Verdict.parse({ ok: false, problems: ["x"], unsafe: true }).unsafe).toBe(true);
  });
});
