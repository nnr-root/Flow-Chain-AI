import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { formatStatus } from "../../src/status.js";

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
    expect(text).toContain("Run stages: script ✓  captions ·  render ·");
    expect(text).toContain("Scene 1 [mode 1]: tts ✓  silence ·  keyframes ·  clips ✗  fit ·");
    expect(text).toContain("  error in clips: boom");
    // Mode 2 has no clip or fit: it is animated from its keyframe at render time
    expect(text).toContain("Scene 2 [mode 2]: tts ·  silence ·  keyframes ·");
    expect(text).not.toMatch(/Scene 2 .*clips/);
    expect(text).toContain("Spend (estimated from the price table, not invoices): $0.26 across 2 paid call(s)");
    expect(text).not.toContain("Final:");
  });
});
