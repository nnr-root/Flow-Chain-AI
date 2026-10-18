import { describe, expect, it } from "vitest";
import { formatById } from "../../src/formats.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";

const base = { topic: "How tides work", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;

describe("a top list", () => {
  it("is delivered item by item but as one piece, never against the rule that every script flows", () => {
    const p = buildScriptPrompt({ ...base, format: "countdown" });
    expect(p).toContain("It is one spoken piece, not a list of facts read out");
    expect(p).not.toContain("nothing between the items");
    expect(p).toContain(`- Delivery: ${formatById("countdown")!.delivery}`);
    expect(formatById("countdown")!.delivery).toContain("its lines told as one piece");
  });
});
