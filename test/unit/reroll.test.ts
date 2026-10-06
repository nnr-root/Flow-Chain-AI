import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { bumpNonce } from "../../src/reroll.js";
import { fakeScript } from "../fakes/providers.js";

function manifest(extra: Record<string, unknown> = {}) {
  const m = createManifest(
    "r",
    { topic: "t", aspect: "9:16", sceneCount: 3, modes: [1, 1, 1], voiceId: "v", ...extra },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );
  m.script = fakeScript(3, { shots: ["cut", "continue", "cut"] });
  return m;
}

describe("bumpNonce", () => {
  it("increments the nonce of a 1-based scene", () => {
    const m = manifest();
    bumpNonce(m, 2, "clips");
    bumpNonce(m, 2, "clips");
    expect(m.scenes[1].nonces.clips).toBe(2);
  });

  it("rejects unknown stages and out-of-range scenes", () => {
    expect(() => bumpNonce(manifest(), 1, "fit")).toThrow(/cannot reroll "fit"/);
    expect(() => bumpNonce(manifest(), 0, "tts")).toThrow(/between 1 and 3/);
    expect(() => bumpNonce(manifest(), 4, "tts")).toThrow(/between 1 and 3/);
  });

  it("refuses to reroll the clips of a Mode 2 scene (it has none) and points to its keyframe", () => {
    const m = manifest();
    m.scenes[1].mode = 2;
    expect(() => bumpNonce(m, 2, "clips")).toThrow(/scene 2 is Mode 2: it has no clip.*--stage keyframes/);
    expect(m.scenes[1].nonces.clips).toBeUndefined();
    expect(() => bumpNonce(m, 2, "keyframes")).not.toThrow();
  });

  it("refuses to reroll a keyframe the scene does not use", () => {
    expect(() => bumpNonce(manifest(), 2, "keyframes")).toThrow(/reroll its clips instead/);
    expect(() => bumpNonce(manifest(), 3, "keyframes")).not.toThrow();
  });

  it("rerolls the generated reference portrait of a RunPod run, from scene 1 only", () => {
    const m = manifest({ imageProfile: "runpod-sdxl@1" });
    bumpNonce(m, 1, "reference");
    expect(m.scenes[0].nonces.reference).toBe(1);
    expect(() => bumpNonce(m, 2, "reference")).toThrow(/reference portrait is made in scene 1/);
    expect(m.scenes[1].nonces.reference).toBeUndefined();
  });

  it("refuses a reference reroll when the run has no generated portrait", () => {
    expect(() => bumpNonce(manifest(), 1, "reference")).toThrow(/has no generated reference portrait/);
    const brand = manifest({ imageProfile: "runpod-sdxl@1", referenceImage: "brand/reference.png" });
    expect(() => bumpNonce(brand, 1, "reference")).toThrow(/has no generated reference portrait/);
    expect(brand.scenes[0].nonces.reference).toBeUndefined();
  });
});
