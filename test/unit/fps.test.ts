import { describe, expect, it } from "vitest";
import { FPS, fpsOf } from "../../src/config.js";
import { RunRequest } from "../../src/manifest/schema.js";
import { createManifest } from "../../src/manifest/store.js";

describe("the frame rate of a run", () => {
  it("is the pipeline's 30 unless the run was made for 60", () => {
    expect(fpsOf({})).toBe(FPS);
    expect(FPS).toBe(30);
    expect(fpsOf({ fps: 60 })).toBe(60);
  });

  it("is a choice of 60 or nothing: a request never names 30 or any other rate", () => {
    const fps = RunRequest.shape.fps;
    expect(fps.safeParse(60).success).toBe(true);
    expect(fps.safeParse(undefined).success).toBe(true);
    for (const bad of [30, 24, 59, 120, "60", true]) expect(fps.safeParse(bad).success, String(bad)).toBe(false);
  });

  it("is not in the request of a run that did not ask for it, so its saved manifest is what it was", () => {
    const m = createManifest("r", { topic: "foxes", aspect: "9:16", sceneCount: 2, modes: [1, 1], voiceId: "v" }, { llm: "l", tts: "t", image: "i", video: "v" });
    expect(Object.keys(m.request)).not.toContain("fps");
    expect(JSON.stringify(m.request)).not.toContain("fps");
  });
});
