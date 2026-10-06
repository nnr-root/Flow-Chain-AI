import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { round4, scriptCost } from "../../src/cost.js";
import type { ActionLevel, Shot } from "../../src/manifest/schema.js";
import { planModes } from "../../src/modes.js";

// Only images and clips cost money here: a keyframe is $0.025 (1 MP), a 5 s clip $0.25, a 10 s clip $0.50.
const prices = Prices.parse({ llmPerMInputTokens: 0, llmPerMOutputTokens: 0, ttsPer1kChars: 0 });
const keyframeSize = { width: 1000, height: 1000 };

function plan(levels: ActionLevel[], budgetUsd: number, opts: { shots?: Shot[]; secs?: Array<5 | 10> } = {}) {
  const scenes = levels.map((actionLevel, i) => ({
    actionLevel,
    shot: opts.shots?.[i] ?? "cut",
    requestedSec: opts.secs?.[i] ?? 5,
    narrationChars: 100,
  }));
  return planModes({ scenes, prices, keyframeSize, budgetUsd });
}

describe("planModes", () => {
  it("maps high and medium to Mode 1 and low to Mode 2 when the budget allows", () => {
    const r = plan(["high", "medium", "low"], 10);
    expect(r.modes).toEqual([1, 1, 2]);
    expect(r.reasons).toEqual(["auto: high action", "auto: medium action", "auto: low action"]);
    expect(r.estimatedUsd).toBe(0.575); // 3 keyframes + 2 clips
  });

  it("downgrades the medium scene with the largest saving first", () => {
    // $1.075; dropping the 10 s clip saves $0.50, the 5 s clip only $0.25
    const r = plan(["high", "medium", "medium"], 0.9, { secs: [5, 10, 5] });
    expect(r.modes).toEqual([1, 2, 1]);
    expect(r.reasons[1]).toBe("auto: medium action → Mode 2 to fit $0.90");
    expect(r.reasons[2]).toBe("auto: medium action");
    expect(r.estimatedUsd).toBe(0.575);
  });

  it("breaks a tie in favour of the later scene", () => {
    const r = plan(["high", "medium", "medium"], 0.6); // $0.825, either medium saves $0.25
    expect(r.modes).toEqual([1, 1, 2]);
  });

  it("counts the keyframes a downgrade adds by breaking a continue chain", () => {
    // scene 3 → Mode 2 needs keyframes for scenes 3 and 4 (saves $0.20); scene 2 → Mode 2 only for scene 3 ($0.225)
    const r = plan(["high", "medium", "medium", "high"], 0.9, { shots: ["cut", "cut", "continue", "continue"] });
    expect(r.modes).toEqual([1, 2, 1, 1]);
    expect(r.estimatedUsd).toBe(0.825);
  });

  it("downgrades medium scenes until the run fits", () => {
    const r = plan(["medium", "medium", "medium"], 0.4);
    expect(r.modes).toEqual([1, 2, 2]);
    expect(r.estimatedUsd).toBe(0.325);
  });

  it("keeps high scenes in Mode 1 even when the run stays over budget", () => {
    const r = plan(["high", "medium", "high"], 0.1);
    expect(r.modes).toEqual([1, 2, 1]);
    expect(r.reasons).toEqual([
      "auto: high action",
      "auto: medium action → Mode 2 to fit $0.10",
      "auto: high action",
    ]);
    expect(r.estimatedUsd).toBe(0.575);
  });

  it("includes the script and voiceover in the run's cost", () => {
    const withAudio = planModes({
      scenes: [{ actionLevel: "high", shot: "cut", requestedSec: 5, narrationChars: 1000 }],
      prices: Prices.parse({}),
      keyframeSize,
      budgetUsd: 10,
    });
    // script $0.0055 + voiceover $0.30 + keyframe $0.025 + clip $0.25
    expect(withAudio.estimatedUsd).toBe(0.5805);
  });
});

describe("planModes with pinned scenes", () => {
  const scenes = (levels: ActionLevel[]) =>
    levels.map((actionLevel) => ({ actionLevel, shot: "cut" as Shot, requestedSec: 5, narrationChars: 100 }));

  it("starts a pinned scene at its pinned mode, whatever its action level, and says who decided", () => {
    const r = planModes({ scenes: scenes(["high", "low", "medium"]), prices, keyframeSize, budgetUsd: 10, pinned: [2, 1, null] });
    expect(r.modes).toEqual([2, 1, 1]);
    expect(r.reasons).toEqual(["set by you", "set by you", "auto: medium action"]);
    expect(r.estimatedUsd).toBe(0.575); // 3 keyframes + 2 clips
  });

  it("never downgrades a pinned clip to fit the budget; the other medium scene goes instead", () => {
    // $0.825 for three clips; the later medium scene would normally be dropped first, but it is pinned
    const r = planModes({ scenes: scenes(["high", "medium", "medium"]), prices, keyframeSize, budgetUsd: 0.6, pinned: [null, null, 1] });
    expect(r.modes).toEqual([1, 2, 1]);
    expect(r.reasons).toEqual(["auto: high action", "auto: medium action → Mode 2 to fit $0.60", "set by you"]);
  });

  it("plans exactly as without pins when every entry is null", () => {
    const input = { scenes: scenes(["high", "medium", "low"]), prices, keyframeSize, budgetUsd: 10 };
    expect(planModes({ ...input, pinned: [null, null, null] })).toEqual(planModes(input));
  });
});

describe("planModes on RunPod profiles", () => {
  it("adds each endpoint's cold start once: images always, video only when a scene is Mode 1", () => {
    const base = { prices: Prices.parse({}), keyframeSize: { width: 1000, height: 1000 }, budgetUsd: 10 };
    const scenes = [{ actionLevel: "low" as const, shot: "cut" as const, requestedSec: 81 / 16, narrationChars: 0 }];
    const stills = planModes({ ...base, scenes, imageProfile: "runpod-sdxl@1", videoProfile: "wan22-480p@1" });
    // script + 1 keyframe (8 s × $0.000306) + the keyframe endpoint's cold start; no clip, so no clip cold start
    expect(stills.estimatedUsd).toBe(round4(scriptCost(base.prices) + 0.0024 + 0.0275));
    const moving = planModes({
      ...base,
      scenes: [{ ...scenes[0], actionLevel: "high" }],
      imageProfile: "runpod-sdxl@1",
      videoProfile: "wan22-480p@1",
    });
    expect(moving.estimatedUsd).toBe(round4(scriptCost(base.prices) + 0.0024 + 0.0275 + 0.0372 + 0.0275));
  });
});

