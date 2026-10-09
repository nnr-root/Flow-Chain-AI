import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError, isRetryable, NonRetryableError, UnusableResultError } from "../../src/providers/retry.js";
import { buildScriptPrompt, scriptJsonSchema } from "../../src/providers/gemini.js";
import { PRESETS } from "../../src/presets.js";

describe("gemini prompt and schema", () => {
  it("asks for the exact scene count and word cap", () => {
    const p = buildScriptPrompt({ topic: "octopus intelligence", sceneCount: 5, aspect: "9:16" });
    expect(p).toContain('"octopus intelligence"');
    expect(p).toContain("exactly 5 scenes");
    expect(p).toContain("at most 16 words (ideally 12-15)");
    expect(p).toContain("vertical 9:16");
    expect(p).not.toContain("rejected");
  });

  it("pins the shot values when the run fixes them", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 3, aspect: "9:16", shots: ["cut", "continue", "continue"] });
    expect(p).toContain('Use exactly these shot values, in order: scene 1 "cut", scene 2 "continue", scene 3 "continue"');
    expect(buildScriptPrompt({ topic: "t", sceneCount: 3, aspect: "9:16" })).not.toContain("Use exactly these shot values");
  });

  it("lists the style presets and lets Gemini pick one, or pins --style", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16" });
    for (const preset of Object.values(PRESETS)) expect(p).toContain(`- ${preset.name}: ${preset.description}`);
    expect(p).toContain("stylePreset: set it to the preset that best fits the topic");
    const pinned = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16", style: "anime" });
    expect(pinned).toContain('stylePreset: use exactly "anime"');
    expect(pinned).not.toContain("best fits the topic");
  });

  it("pins the character bible when the run has one", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16", characters: "Nova: silver bob" });
    expect(p).toContain('- styleBible.characters: use exactly: "Nova: silver bob". Refer to these characters consistently');
    expect(buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16" })).toContain(
      "- styleBible.characters: a precise, reusable description",
    );
  });

  it("asks for a short teasing hook", () => {
    expect(buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16" })).toContain(
      "- hook: 2-6 punchy words shown as a big title over the first 3 seconds",
    );
  });

  it("explains actionLevel and suggestedTransition", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16" });
    expect(p).toContain('- actionLevel: "high" for fast or complex motion worth real video');
    expect(p).toContain("- suggestedTransition: how the cut into this scene should feel");
    expect(p).toContain("Do not describe the art style");
  });

  it("appends validation feedback on retry", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "16:9", feedback: "scene 2 narration has 30 words" });
    expect(p).toContain("rejected");
    expect(p).toContain("scene 2 narration has 30 words");
  });

  it("produces a JSON schema without $schema", () => {
    const s = scriptJsonSchema() as { $schema?: string; properties: { scenes: { maxItems: number } } };
    expect(s.$schema).toBeUndefined();
    expect(s.properties.scenes.maxItems).toBe(12);
  });

  it("requires the 2.2 fields in Gemini's answer", () => {
    const s = scriptJsonSchema() as {
      required: string[];
      properties: { scenes: { items: { required: string[] } } };
    };
    expect(s.required).toContain("stylePreset");
    expect(s.properties.scenes.items.required).toEqual(expect.arrayContaining(["actionLevel", "suggestedTransition", "showsCharacter"]));
  });
});
