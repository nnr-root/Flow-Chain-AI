import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { bumpNonce } from "../../src/reroll.js";
import { fakeScript } from "../fakes/providers.js";

function manifest() {
  const m = createManifest(
    "r",
    { topic: "t", aspect: "9:16", sceneCount: 3, modes: [1, 1, 1], voiceId: "v" },
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

  it("refuses to reroll the deterministic clip of a Mode 2 scene and points to its keyframe", () => {
    const m = manifest();
    m.scenes[1].mode = 2;
    expect(() => bumpNonce(m, 2, "clips")).toThrow(/scene 2 is Mode 2.*--stage keyframes/);
    expect(m.scenes[1].nonces.clips).toBeUndefined();
    expect(() => bumpNonce(m, 2, "keyframes")).not.toThrow();
  });

  it("refuses to reroll a keyframe the scene does not use", () => {
    expect(() => bumpNonce(manifest(), 2, "keyframes")).toThrow(/reroll its clips instead/);
    expect(() => bumpNonce(manifest(), 3, "keyframes")).not.toThrow();
  });
});
