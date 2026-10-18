import { describe, expect, it } from "vitest";
import { EDITS } from "../../src/edits.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";

const base = { topic: "How tides work", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;

describe("an edit, as the script is told it", () => {
  it("is named, with how to frame, move and cut, and not the form's words for its finish (tape, grain, colour)", () => {
    for (const e of EDITS) {
      const p = buildScriptPrompt({ ...base, edit: e.id });
      expect(p, e.id).toContain(`Edit: ${e.label}. Frame, move and cut the scenes for it;`);
      expect(p, e.id).not.toContain(e.about.toLowerCase());
      for (const line of e.script) expect(p, e.id).toContain(line);
    }
  });
});
