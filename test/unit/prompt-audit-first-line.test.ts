import { describe, expect, it } from "vitest";
import { formatById } from "../../src/formats.js";
import { nicheById } from "../../src/niches.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";

const base = { topic: "How tides work", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;
const LABEL = "- First line (scene 1's narration, not the hook title):";

describe("how a niche or a type opens", () => {
  it("is given as the first line, so a sentence meant for scene 1 is never read as the hook title", () => {
    const scary = nicheById("scary-stories")!;
    const p = buildScriptPrompt({ ...base, niche: "scary-stories" });
    expect(p).toContain(`${LABEL} ${scary.hook}`);
    expect(p).not.toMatch(/^- Hook: /m);

    const doc = formatById("documentary")!;
    const q = buildScriptPrompt({ ...base, niche: "history", format: "documentary" });
    expect(q).toContain(`${LABEL} ${doc.hook}`);
    expect(q).not.toMatch(/^- Hook: /m);
    expect(q).toContain("the video type decides the first line, the shape and the delivery");
  });

  it("leaves the hook title's own rule as it is", () => {
    expect(buildScriptPrompt({ ...base, niche: "scary-stories" })).toContain("- hook: 2-6 punchy words shown as a big title");
  });
});
