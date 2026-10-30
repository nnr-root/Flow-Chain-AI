import { describe, expect, it } from "vitest";
import { LlmOutline, LlmScript, Script, SceneSpec, StoredOutline } from "../../src/manifest/schema.js";
import { buildScriptPrompt, scriptJsonSchema } from "../../src/providers/gemini.js";
import { fakeScript } from "../fakes/providers.js";

describe("a script's sound fields", () => {
  it("are optional when stored, so a script from before them still loads, soundCues and all", () => {
    const old = { ...fakeScript(2), soundBible: undefined, scenes: fakeScript(2).scenes.map((s) => ({ ...s, soundPrompt: undefined, soundCues: [{ sound: "door", at: "start" }] })) };
    const parsed = Script.parse(old);
    expect(parsed.soundBible).toBeUndefined();
    expect(parsed.scenes[0].soundPrompt).toBeUndefined();
    expect("soundCues" in parsed.scenes[0]).toBe(false);
  });
  it("are required in what Gemini answers", () => {
    const answer = fakeScript(2);
    expect(LlmScript.safeParse(answer).success).toBe(true);
    expect(LlmScript.safeParse({ ...answer, soundBible: undefined }).success).toBe(false);
    expect(LlmScript.safeParse({ ...answer, scenes: [{ ...answer.scenes[0], soundPrompt: undefined }, answer.scenes[1]] }).success).toBe(false);
  });
  it("hold a bible of at most 300 characters and a prompt of at most 200", () => {
    expect(SceneSpec.safeParse({ ...fakeScript(1).scenes[0], soundPrompt: "x".repeat(201) }).success).toBe(false);
    expect(Script.safeParse({ ...fakeScript(1), soundBible: "x".repeat(301) }).success).toBe(false);
  });
  it("reach Gemini as plain strings: no enum and no maxItems anywhere near them (it refused such a schema whole, 2026-10-30)", () => {
    for (const kind of ["script", "part"] as const) {
      const schema = JSON.stringify(scriptJsonSchema(kind, 16));
      expect(schema, kind).toContain("soundPrompt");
      expect(schema, kind).not.toContain("soundCues");
    }
    const top = scriptJsonSchema("script", 16) as { properties: Record<string, Record<string, unknown>> };
    expect(top.properties.soundBible).toMatchObject({ type: "string" });
    expect(Object.keys(top.properties.soundBible)).not.toContain("enum");
  });
  it("come before the scenes in the script's schema, so the bible is settled first", () => {
    const keys = Object.keys((scriptJsonSchema("script", 16) as { properties: Record<string, unknown> }).properties);
    expect(keys.indexOf("soundBible")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("soundBible")).toBeLessThan(keys.indexOf("scenes"));
  });
});

describe("the script prompt", () => {
  const prompt = buildScriptPrompt({ topic: "t", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" });
  it("asks for a sound bible first and a sound prompt for every scene, and says what they may not hold", () => {
    expect(prompt).toMatch(/soundBible/);
    expect(prompt).toMatch(/soundPrompt/);
    expect(prompt).toMatch(/no speech, voices, singing or music/i);
    expect(prompt).toMatch(/room tone/i);
    expect(prompt).toMatch(/differ/i);
  });
  it("no longer mentions the library's sounds", () => {
    expect(prompt).not.toMatch(/soundCues|footstep|heartbeat/);
  });
});

describe("a long video's sound bible", () => {
  const { scenes: _scenes, ...head } = fakeScript(1);
  const outline = LlmOutline.parse({ ...head, parts: [{ summary: "a" }, { summary: "b" }] });
  const req = { topic: "t", aspect: "9:16" as const, sceneCount: 4, voiceId: "narrator-m" as const, timing: { targetSec: 120, sceneSec: { min: 3, max: 5 } } };
  it("is required in the outline's answer and asked for there, once", () => {
    expect(LlmOutline.safeParse({ ...outline, soundBible: undefined }).success).toBe(false);
    expect(buildScriptPrompt({ ...req, ask: { kind: "outline", partSec: [60, 60] } })).toContain("soundBible (once, before the scenes)");
  });
  it("is kept in the stored outline, optional there, and handed to the parts", () => {
    expect(StoredOutline.parse(outline).soundBible).toBe(outline.soundBible);
    const { soundBible: _gone, ...old } = outline;
    expect(StoredOutline.safeParse(old).success).toBe(true);
    const ask = { kind: "part" as const, index: 0, partSec: [60, 60], outline: StoredOutline.parse(outline), previous: [] };
    expect(buildScriptPrompt({ ...req, ask })).toContain(outline.soundBible);
  });
});
