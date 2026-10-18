import { describe, expect, it } from "vitest";
import { PROMPT_VERSION, TEMPERATURE, temperatureOf } from "../../src/providers/prompt-version.js";
import { GeminiLlm } from "../../src/providers/gemini.js";

const base = { topic: "foxes", aspect: "9:16", sceneCount: 3 } as const;

describe("the prompt version", () => {
  it("is a dated version", () => {
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("gives each kind of answer its own temperature", () => {
    expect(temperatureOf(base)).toBe(TEMPERATURE.script);
    expect(temperatureOf({ ...base, ask: { kind: "outline", partSec: [60, 60] } })).toBe(TEMPERATURE.outline);
    expect(temperatureOf({ ...base, ask: { kind: "translate", source: { title: "t", hook: "h", narrations: ["a"] }, seconds: [3] } })).toBe(TEMPERATURE.translate);
  });

  it("is carried by the model that writes scripts, so a run can say which prompt wrote its script", () => {
    expect(new GeminiLlm("key", "model").promptVersion).toBe(PROMPT_VERSION);
  });
});
