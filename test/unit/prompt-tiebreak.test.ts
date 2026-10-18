import { describe, expect, it } from "vitest";
import { pinnedPrompts } from "../helpers/prompt-pins.js";

describe("the prompts that are pinned", () => {
  it("include the tie-break between a niche and a video type, so an edit to it moves a hash", () => {
    const withTieBreak = Object.entries(pinnedPrompts()).filter(([, text]) => text.includes("the niche decides the subject and the tone"));
    expect(withTieBreak.length).toBeGreaterThan(0);
  });
});
