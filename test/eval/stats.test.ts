import { describe, expect, it } from "vitest";
import { compare, metricsOf, spreadOf, summaryText, type RunRecord } from "../../src/eval/stats.js";

const run = (caseId: string, repeat: number, accepted: boolean, extra = 0, judge?: Record<string, number | null>): RunRecord => ({
  caseId,
  repeat,
  outcome: { steps: [{ step: "script", accepted, problems: accepted ? [] : ["x"], extra: Array.from({ length: extra }, () => ({ check: "c", where: "w", detail: "d" })) }], scenes: [] },
  judge,
});

describe("spread", () => {
  it("is the sample standard deviation, and zero for one value", () => {
    expect(spreadOf([1, 1, 1])).toEqual({ mean: 1, spread: 0, n: 3 });
    expect(spreadOf([2])).toEqual({ mean: 2, spread: 0, n: 1 });
    expect(spreadOf([0, 1]).spread).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

describe("the metrics of a set of runs", () => {
  const runs = [run("a", 0, true), run("a", 1, false), run("b", 0, true), run("b", 1, true, 1, { paintable: 4, continuity: null })];
  const m = metricsOf(runs);
  it("counts first-try acceptance overall, over the repeats, and per case", () => {
    expect(m.accepted.mean).toBeCloseTo(0.75);
    expect(m["accepted:a"].mean).toBeCloseTo(0.5);
    expect(m["accepted:b"].mean).toBe(1);
  });
  it("counts the share of runs with no extra finding", () => expect(m.extra.mean).toBeCloseTo(0.75));
  it("averages a judge score, and leaves out one that did not apply", () => {
    expect(m["judge:paintable"].mean).toBe(4);
    expect(m["judge:continuity"]).toBeUndefined();
  });
});

describe("comparing with a baseline", () => {
  const base = { accepted: { mean: 0.9, spread: 0.05, n: 3 }, "judge:flow": { mean: 4, spread: 0.4, n: 3 } };
  it("flags a drop larger than the spread, and not one inside it", () => {
    expect(compare({ accepted: { mean: 0.7, spread: 0.02, n: 3 }, "judge:flow": { mean: 3.7, spread: 0.1, n: 3 } }, base).regressed.map((r) => r.metric)).toEqual(["accepted"]);
  });
  it("never flags a drop under the smallest that means anything, even when the spread is zero", () => {
    expect(compare({ accepted: { mean: 0.88, spread: 0, n: 3 } }, { accepted: { mean: 0.9, spread: 0, n: 3 } }).regressed).toEqual([]);
  });
  it("reports a gain, and ignores a metric the baseline does not have", () => {
    const cmp = compare({ accepted: { mean: 1, spread: 0, n: 3 }, "judge:new": { mean: 1, spread: 0, n: 3 } }, base);
    expect(cmp.improved.map((r) => r.metric)).toEqual(["accepted"]);
  });
});

describe("the summary", () => {
  it("names the version, lists the metrics and the regressions", () => {
    const text = summaryText("v1", { accepted: { mean: 0.5, spread: 0.1, n: 3 } }, { regressed: [{ metric: "accepted", before: 0.9, after: 0.5 }], improved: [] });
    expect(text).toContain("v1");
    expect(text).toContain("accepted");
    expect(text).toContain("0.90 → 0.50");
  });
});
