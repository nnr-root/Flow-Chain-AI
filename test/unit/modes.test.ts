import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
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
