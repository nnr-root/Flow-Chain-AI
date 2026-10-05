import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { applyRenderOptions, assertRenderOnly, noPaidProviders } from "../../src/rerender.js";

const manifest = () =>
  createManifest(
    "run-1",
    { topic: "t", aspect: "9:16", sceneCount: 1, modes: [1], voiceId: "v" },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );

describe("applyRenderOptions", () => {
  it("starts from the defaults and changes only what is given", () => {
    const m = manifest();
    expect(m.request.render).toEqual({ captionStyle: "preset", transition: "auto", bgmGain: 0.35, sfx: true, sfxGain: 0.6 });
    applyRenderOptions(m, { captionStyle: "mrbeast" });
    expect(m.request.render).toEqual({ captionStyle: "mrbeast", transition: "auto", bgmGain: 0.35, sfx: true, sfxGain: 0.6 });
    applyRenderOptions(m, { transition: "glitch", bgmGain: "0.2" });
    expect(m.request.render).toEqual({ captionStyle: "mrbeast", transition: "glitch", bgmGain: 0.2, sfx: true, sfxGain: 0.6 });
    applyRenderOptions(m, { captionStyle: "preset", transition: "auto" });
    expect(m.request.render).toEqual({ captionStyle: "preset", transition: "auto", bgmGain: 0.2, sfx: true, sfxGain: 0.6 });
  });

  it("rejects invalid values", () => {
    expect(() => applyRenderOptions(manifest(), { bgmGain: "2" })).toThrow();
    expect(() => applyRenderOptions(manifest(), { captionStyle: "comic" })).toThrow();
  });
});

describe("assertRenderOnly", () => {
  it("allows a plan of free modes/captions/render steps only", () => {
    expect(() =>
      assertRenderOnly(
        { items: [{ stage: "captions", costUsd: 0 }, { stage: "render", costUsd: 0 }], totalUsd: 0 },
        "run-1",
      ),
    ).not.toThrow();
    // a run made before 2.2 has never run the (free) modes stage
    expect(() => assertRenderOnly({ items: [{ stage: "modes", costUsd: 0 }], totalUsd: 0 }, "run-1")).not.toThrow();
  });

  it("refuses when paid or earlier work would run", () => {
    expect(() =>
      assertRenderOnly(
        { items: [{ stage: "clips", scene: 1, costUsd: 0.25 }, { stage: "render", costUsd: 0 }], totalUsd: 0.25 },
        "run-1",
      ),
    ).toThrow("run run-1 is not complete (clips scene 2 would run); use resume");
    expect(() => assertRenderOnly({ items: [{ stage: "fit", scene: 0, costUsd: 0 }], totalUsd: 0 }, "run-1")).toThrow(
      /fit scene 1 would run/,
    );
  });
});

describe("noPaidProviders", () => {
  it("refuses every provider call", async () => {
    const p = noPaidProviders();
    await expect(p.video.submit({ input: {} }, { signal: new AbortController().signal })).rejects.toThrow(
      "rerender never calls a paid provider",
    );
    await expect(p.llm.generateScript({ topic: "t", sceneCount: 1, aspect: "9:16" })).rejects.toThrow();
  });
});
