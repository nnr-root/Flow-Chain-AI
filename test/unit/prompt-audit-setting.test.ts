import { describe, expect, it } from "vitest";
import { buildScriptPrompt } from "../../src/providers/gemini.js";

const base = { topic: "How tides work", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;
const timing = { targetSec: 120, sceneSec: { min: 3, max: 5 } };

describe("the setting's example", () => {
  it("gives the form of a setting, not one siege's soldiers and things, in a script and an outline", () => {
    for (const p of [buildScriptPrompt(base), buildScriptPrompt({ ...base, timing, ask: { kind: "outline", partSec: [60, 60] } })]) {
      expect(p).not.toContain("Constantinople");
      expect(p).toContain('(in the form "<place>, <season> <year>: <what people there wear>; <what they use>; <the buildings and the light>")');
    }
  });
});
