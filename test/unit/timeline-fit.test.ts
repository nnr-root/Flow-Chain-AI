import { describe, expect, it } from "vitest";
import { fitFilter, planFit } from "../../src/media/fit.js";
import { audioStarts, sceneFrameCounts } from "../../src/media/timeline.js";

describe("sceneFrameCounts", () => {
  it("uses cumulative rounding so the total never drifts", () => {
    expect(sceneFrameCounts([1.01, 1.01, 1.01], 30)).toEqual([30, 31, 30]);
  });

  it("always sums to round(total * fps)", () => {
    const durations = [2.137, 4.481, 0.999, 7.333, 3.0166, 5.5];
    const total = durations.reduce((a, b) => a + b, 0);
    const counts = sceneFrameCounts(durations, 30);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(Math.round(total * 30));
  });
});

describe("audioStarts", () => {
  it("returns cumulative start times", () => {
    expect(audioStarts([1.5, 2, 0.5])).toEqual([0, 1.5, 3.5]);
  });
});

describe("planFit", () => {
  it("trims when the clip is long enough", () => {
    expect(planFit(5, 4.2)).toEqual({ kind: "trim" });
    expect(planFit(5, 5)).toEqual({ kind: "trim" });
  });

  it("slows down by up to 1.25x", () => {
    expect(planFit(5, 6)).toEqual({ kind: "slow", factor: 1.2 });
    expect(planFit(5, 6.25)).toEqual({ kind: "slow", factor: 1.25 });
  });

  it("freezes the tail beyond 1.25x", () => {
    expect(planFit(5, 7)).toEqual({ kind: "slow+freeze", factor: 1.25, freezeSec: 0.75 });
  });
});

describe("fitFilter", () => {
  const size = { width: 1080, height: 1920 };

  it("normalizes size and fps and always pads the tail", () => {
    expect(fitFilter({ kind: "trim" }, size, 30)).toBe(
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.500",
    );
  });

  it("slows with setpts and extends the freeze for freeze plans", () => {
    const f = fitFilter({ kind: "slow+freeze", factor: 1.25, freezeSec: 0.75 }, size, 30);
    expect(f.startsWith("setpts=1.25*PTS,")).toBe(true);
    expect(f.endsWith("tpad=stop_mode=clone:stop_duration=1.250")).toBe(true);
  });
});
