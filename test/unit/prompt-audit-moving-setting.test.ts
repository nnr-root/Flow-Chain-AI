import { describe, expect, it } from "vitest";
import { buildScriptPrompt } from "../../src/providers/gemini.js";

const base = { topic: "How tides work", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;

describe("the example of a video that moves between times and places", () => {
  it("gives the form of the list and names none of the wars of the test video it was written after", () => {
    const p = buildScriptPrompt({ ...base, format: "countdown" });
    for (const name of ["Zanzibar", "Honduras", "Sinai"]) expect(p, name).not.toContain(name);
    expect(p).toContain('(in the form "Several times and places: <place> <year>, <place> <year>, <place> <year>")');
    // the rule itself is unchanged
    expect(p).toContain('begin it with "Several times and places:"');
  });
});
