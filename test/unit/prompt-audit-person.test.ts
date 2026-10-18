import { describe, expect, it } from "vitest";
import { formatById } from "../../src/formats.js";
import { nicheById } from "../../src/niches.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";

const base = { topic: "How tides work", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;
const TIE = "the video type decides the first line, the shape and the delivery, and the person and tense it is told in; the niche decides the subject and the tone, and its rules always hold";

describe("a niche and a type that tell in different persons", () => {
  it("are told that the type's person and tense win", () => {
    // scary stories are first person, past tense; "You are there" is second person, present tense
    const p = buildScriptPrompt({ ...base, niche: "scary-stories", format: "pov" });
    expect(p).toContain(nicheById("scary-stories")!.voice);
    expect(p).toContain(formatById("pov")!.delivery);
    expect(p).toContain(TIE);
    // motivation talks to "you"; a documentary is third person
    expect(buildScriptPrompt({ ...base, niche: "motivation", format: "documentary" })).toContain(TIE);
  });
});
