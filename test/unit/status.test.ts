import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { createManifest } from "../../src/manifest/store.js";
import { formatStatus } from "../../src/status.js";
import { fakeScript } from "../fakes/providers.js";

describe("formatStatus", () => {
  it("summarizes stages, errors, spend and output", () => {
    const m = createManifest(
      "20261002-140509-abcdef",
      { topic: "foxes", aspect: "9:16", sceneCount: 2, modes: [1, 2], voiceId: "v" },
      { llm: "gemini-flash-latest", tts: "eleven_multilingual_v2", image: "fal-ai/flux/dev", video: "kling" },
    );
    const done = { status: "done" as const, inputHash: "h", costUsd: 0, finishedAt: "t" };
    m.runStages.script = done;
    m.scenes[0].stages.tts = done;
    m.scenes[0].stages.clips = { ...done, status: "failed", error: "boom" };
    m.ledger = [
      { stage: "script", usd: 0.01, at: "t" },
      { stage: "tts", scene: 0, usd: 0.25, at: "t" },
    ];
    const text = formatStatus(m);
    expect(text).toContain("Run 20261002-140509-abcdef — 9:16, 2 scenes, modes 1,2");
    expect(text).toContain("Style: chosen by Gemini when the script is written");
    expect(text).toContain("Run stages: script ✓  modes ·  captions ·  render ·");
    expect(text).toContain("Scene 1 [mode 1]: tts ✓  silence ·  keyframes ·  clips ✗  fit ·");
    expect(text).toContain("  error in clips: boom");
    // Mode 2 has no clip or fit: it is animated from its keyframe at render time
    expect(text).toContain("Scene 2 [mode 2]: tts ·  silence ·  keyframes ·");
    expect(text).not.toMatch(/Scene 2 .*clips/);
    expect(text).toContain("Spend (estimated from the price table, not invoices): $0.26 across 2 paid call(s)");
    expect(text).not.toContain("Final:");
  });

  it("shows the preset with its source and each scene's mode reason", () => {
    const m = createManifest(
      "r",
      { topic: "foxes", aspect: "9:16", sceneCount: 2, modeBudgetUsd: 1, modePrices: Prices.parse({}), voiceId: "v" },
      { llm: "l", tts: "t", image: "i", video: "v" },
    );
    m.script = { ...fakeScript(2), stylePreset: "cyberpunk" };
    m.scenes[0].modeReason = "auto: high action";
    m.scenes[1].mode = 2;
    m.scenes[1].modeReason = "auto: low action";
    expect(formatStatus(m)).toContain("9:16, 2 scenes, modes auto");
    expect(formatStatus(m)).toContain("Style: cyberpunk (by Gemini)");
    expect(formatStatus(m)).toContain("Scene 1 [mode 1 · auto: high action]: ");
    expect(formatStatus(m)).toContain("Scene 2 [mode 2 · auto: low action]: ");
    m.request.style = "anime";
    expect(formatStatus(m)).toContain("Style: anime (--style)");
    expect(formatStatus(m)).toContain("Hook: Foxes never sleep · sound effects on (0.6)");
    expect(formatStatus(m)).toContain("Brand: none · characters: by Gemini");
    expect(formatStatus(m)).toContain("Seed: none · video profile: kling-v1");
    m.request.render.hook = false;
    m.request.render.sfx = false;
    m.request.render.brand = {
      name: "Acme",
      logo: "brand/logo.svg",
      watermark: { position: "top-right", widthPct: 14, opacity: 0.8, marginPct: 4 },
    };
    m.request.characters = "Nova: a woman in her 20s, short silver bob, cyan visor over the left eye, black techwear";
    m.request.seed = 42;
    m.request.videoProfile = "kling-v2";
    expect(formatStatus(m)).toContain("Hook: off · sound effects off");
    expect(formatStatus(m)).toContain(
      "Brand: Acme · characters: Nova: a woman in her 20s, short silver bob, cyan visor over…",
    );
    expect(formatStatus(m)).toContain("Seed: 42 · video profile: kling-v2");
    m.request.style = undefined;
    m.script.stylePreset = undefined;
    expect(formatStatus(m)).toContain("Style: none (scripted before style presets)");
  });

  it("shows an unresolved auto run's scenes as not resolved yet", () => {
    const m = createManifest(
      "r",
      { topic: "foxes", aspect: "9:16", sceneCount: 2, modeBudgetUsd: 1, modePrices: Prices.parse({}), voiceId: "v" },
      { llm: "l", tts: "t", image: "i", video: "v" },
    );
    expect(formatStatus(m)).toContain("Scene 1 [mode 1 · auto: not resolved yet]: ");
    expect(formatStatus(m)).toContain("Scene 2 [mode 1 · auto: not resolved yet]: ");
  });
});
