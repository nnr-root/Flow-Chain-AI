import { describe, expect, it } from "vitest";
import { inspectSchema, scriptJsonSchema } from "../../src/providers/gemini.js";

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
