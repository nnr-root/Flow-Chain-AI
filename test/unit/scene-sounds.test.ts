import { describe, expect, it } from "vitest";
import { LlmScript, SceneSpec } from "../../src/manifest/schema.js";
import { buildScriptPrompt, scriptJsonSchema } from "../../src/providers/gemini.js";
import { SCENE_SOUNDS } from "../../src/sounds.js";
import { fakeScript } from "../fakes/providers.js";

const withCues = (cues: unknown) => ({ ...fakeScript(1).scenes[0], soundCues: cues });

describe("a scene's sound cues", () => {
  it("are optional, so a script written before them still loads", () => {
    expect(SceneSpec.safeParse(fakeScript(1).scenes[0]).success).toBe(true);
  });
  it("accept a sound from the vocabulary at start, middle or end", () => {
    expect(SceneSpec.safeParse(withCues([{ sound: "door", at: "middle" }])).success).toBe(true);
  });
  it("refuse a sound outside the vocabulary and a bad position", () => {
    expect(SceneSpec.safeParse(withCues([{ sound: "laser", at: "start" }])).success).toBe(false);
    expect(SceneSpec.safeParse(withCues([{ sound: "door", at: "later" }])).success).toBe(false);
  });
  it("are asked for in a schema with no maxItems: Gemini refuses the whole script for this enum together with a maxItems (measured live, 2026-10-30)", () => {
    for (const kind of ["script", "part"] as const) {
      const schema = scriptJsonSchema(kind, 16) as { properties: { scenes: { items: { properties: { soundCues: Record<string, unknown> } } } } };
      const cues = schema.properties.scenes.items.properties.soundCues;
      expect(cues, kind).toBeDefined();
      expect(Object.keys(cues), kind).not.toContain("maxItems");
    }
  });
  it("are part of the answer Gemini is asked for", () => {
    expect(LlmScript.safeParse({ ...fakeScript(1), scenes: [withCues([{ sound: "rain", at: "start" }])] }).success).toBe(true);
    expect(JSON.stringify(scriptJsonSchema("script", 16))).toContain("soundCues");
    expect(JSON.stringify(scriptJsonSchema("part", 16))).toContain("soundCues");
  });
});

describe("the script prompt", () => {
  it("lists every sound the script may name, and says silence is the default", () => {
    const p = buildScriptPrompt({ topic: "t", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" });
    for (const s of SCENE_SOUNDS) expect(p).toContain(s);
    expect(p).toMatch(/soundCues/);
    expect(p).toMatch(/empty/i);
  });
});
