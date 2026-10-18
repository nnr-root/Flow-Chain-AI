import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { CASES } from "../../src/eval/cases.js";
import { estimateUsd, parseArgs } from "../../src/eval/cost.js";

const prices = Prices.parse({});

describe("what an eval run is expected to cost", () => {
  it("grows with the repeats and with the judge", () => {
    const one = estimateUsd(prices, CASES, 1, false);
    expect(one).toBeGreaterThan(0);
    expect(estimateUsd(prices, CASES, 3, false)).toBeCloseTo(one * 3, 3);
    expect(estimateUsd(prices, CASES, 1, true)).toBeGreaterThan(one);
  });
});

describe("the eval's arguments", () => {
  it("refuse to run without a cap, because it spends money", () => {
    expect(parseArgs([])).toEqual({ error: "--cap <usd> is required: this spends money" });
    expect(parseArgs(["--cap", "0"])).toEqual({ error: "--cap must be a positive number of dollars" });
  });
  it("take sensible defaults", () => {
    expect(parseArgs(["--cap", "2"])).toEqual({ cap: 2, repeats: 3, cases: null, judge: true, saveBaseline: false });
  });
  it("take the options", () => {
    expect(parseArgs(["--cap", "1", "--repeats", "5", "--cases", "a,b", "--no-judge", "--save-baseline"])).toEqual({ cap: 1, repeats: 5, cases: ["a", "b"], judge: false, saveBaseline: true });
  });
  it("refuse fewer repeats than a spread needs when saving a baseline", () => {
    expect(parseArgs(["--cap", "1", "--repeats", "2", "--save-baseline"])).toEqual({ error: "a baseline needs --repeats 3 or more, so its spread means something" });
  });
});
