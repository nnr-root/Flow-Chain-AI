import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { applyRenderOptions, assertRenderOnly, noPaidProviders } from "../../src/rerender.js";

const DEFAULTS = { captionStyle: "preset", transition: "auto", bgmGain: 0.35, hook: true, sfx: true, sfxGain: 0.6 };
const LOOK = {
  name: "Acme",
  logo: "brand/logo.svg",
  watermark: { position: "top-right" as const, widthPct: 14, opacity: 0.8, marginPct: 4 },
};

const manifest = () =>
  createManifest(
    "run-1",
    { topic: "t", aspect: "9:16", sceneCount: 1, modes: [1], voiceId: "v" },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );

describe("applyRenderOptions", () => {
  it("starts from the defaults and changes only what is given", () => {
    const m = manifest();
    expect(m.request.render).toEqual(DEFAULTS);
    applyRenderOptions(m, { captionStyle: "mrbeast" });
    expect(m.request.render).toEqual({ ...DEFAULTS, captionStyle: "mrbeast" });
    applyRenderOptions(m, { transition: "glitch", bgmGain: "0.2" });
    expect(m.request.render).toEqual({ ...DEFAULTS, captionStyle: "mrbeast", transition: "glitch", bgmGain: 0.2 });
    applyRenderOptions(m, { captionStyle: "preset", transition: "auto" });
    expect(m.request.render).toEqual({ ...DEFAULTS, bgmGain: 0.2 });
  });

  it("sets, removes and restores the hook", () => {
    const m = manifest();
    applyRenderOptions(m, { hook: "Night shift" });
    expect(m.request.render).toMatchObject({ hook: true, hookText: "Night shift" });
    applyRenderOptions(m, { hook: false });
    expect(m.request.render).toMatchObject({ hook: false, hookText: "Night shift" });
    applyRenderOptions(m, { hookOn: true });
    expect(m.request.render).toMatchObject({ hook: true, hookText: "Night shift" });
  });

  it("turns sound effects off and on and sets their level", () => {
    const m = manifest();
    applyRenderOptions(m, { sfx: false });
    expect(m.request.render).toMatchObject({ sfx: false, sfxGain: 0.6 });
    applyRenderOptions(m, { sfx: true, sfxGain: "0.3" });
    expect(m.request.render).toMatchObject({ sfx: true, sfxGain: 0.3 });
    expect(() => applyRenderOptions(m, { sfxGain: "1.5" })).toThrow();
  });

  it("applies, keeps and removes a brand look", () => {
    const m = manifest();
    applyRenderOptions(m, { brand: LOOK });
    expect(m.request.render.brand).toEqual(LOOK);
    applyRenderOptions(m, { captionStyle: "mrbeast" });
    expect(m.request.render.brand).toEqual(LOOK);
    applyRenderOptions(m, { brand: null });
    expect(m.request.render.brand).toBeUndefined();
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
