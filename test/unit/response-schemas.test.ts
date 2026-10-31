import { describe, expect, it } from "vitest";
import { LlmPart, LlmScript } from "../../src/manifest/schema.js";
import { inspectSchema, scriptJsonSchema } from "../../src/providers/gemini.js";
import { fakeScript } from "../fakes/providers.js";

type Scenes = { properties: { scenes: { items: { properties: Record<string, unknown> } } } };

describe("the response schemas the model is given", () => {
  it("name the reframe field only for a run that may reframe", () => {
    for (const kind of ["script", "part"] as const) {
      const plain = scriptJsonSchema(kind, 16) as unknown as Scenes;
      // the shape this relies on: the scene's fields sit inline under scenes.items.properties
      expect(Object.keys(plain.properties.scenes.items.properties), kind).toContain("narration");
      expect(JSON.stringify(plain), kind).not.toContain("reframe");
      expect(JSON.stringify(scriptJsonSchema(kind, 16, true)), kind).toContain("reframe");
      expect(Object.keys((scriptJsonSchema(kind, 16, true) as unknown as Scenes).properties.scenes.items.properties), kind).toContain("reframe");
    }
    for (const kind of ["outline", "translate"] as const) expect(JSON.stringify(scriptJsonSchema(kind, 16)), kind).not.toContain("reframe");
  });

  it("name the unsafe field only when the content is checked", () => {
    expect(Object.keys((inspectSchema(false) as { properties: object }).properties)).toEqual(["problems", "ok"]);
    expect(Object.keys((inspectSchema(true) as { properties: object }).properties)).toEqual(["problems", "ok", "unsafe"]);
  });
});

describe("a scene's prompt for LTX and its sentence in the response schemas (phase 15)", () => {
  type Node = { type?: unknown; enum?: unknown; maxItems?: unknown; items?: Node; properties?: Record<string, Node> };
  const arrays = (n: Node, path: string): string[] => [
    ...(n.type === "array" ? [path] : []),
    ...(n.items ? arrays(n.items, `${path}[]`) : []),
    ...Object.entries(n.properties ?? {}).flatMap(([k, v]) => arrays(v, `${path}.${k}`)),
  ];

  it("reach Gemini as plain strings in every scene, with no enum and no list inside a scene for a maxItems to sit on", () => {
    for (const kind of ["script", "part"] as const) {
      for (const reframe of [false, true]) {
        const scene = (scriptJsonSchema(kind, 16, reframe) as unknown as Scenes).properties.scenes.items as unknown as Node;
        for (const field of ["videoPrompt", "speech"]) {
          const node = scene.properties![field];
          expect(node, `${kind} ${field}`).toMatchObject({ type: "string" });
          expect(Object.keys(node), `${kind} ${field}`).not.toContain("enum");
          expect(scene as unknown as { required: string[] }, `${kind} ${field}`).toMatchObject({ required: expect.arrayContaining([field]) });
        }
        // (Gemini refused a whole schema for an enum inside a list with maxItems, 2026-10-30: a scene holds no list at all)
        expect(arrays(scene, "scene"), `${kind} ${reframe}`).toEqual([]);
      }
    }
  });

  it("are required in what Gemini answers, an empty string meaning none, and limited as stored", () => {
    const answer = fakeScript(2);
    expect(LlmScript.safeParse(answer).success).toBe(true);
    expect(LlmScript.safeParse({ ...answer, scenes: [{ ...answer.scenes[0], speech: "" }, answer.scenes[1]] }).success).toBe(true);
    for (const field of ["videoPrompt", "speech"]) {
      const { [field as "speech"]: _gone, ...without } = answer.scenes[0];
      expect(LlmScript.safeParse({ ...answer, scenes: [without, answer.scenes[1]] }).success, field).toBe(false);
      expect(LlmPart.safeParse({ scenes: [without] }).success, field).toBe(false);
    }
    expect(LlmScript.safeParse({ ...answer, scenes: [{ ...answer.scenes[0], videoPrompt: "x".repeat(1201) }] }).success).toBe(false);
    expect(LlmScript.safeParse({ ...answer, scenes: [{ ...answer.scenes[0], speech: "x".repeat(241) }] }).success).toBe(false);
  });
});
