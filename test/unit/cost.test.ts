import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { imageCost, scriptCost, ttsCost, videoCost } from "../../src/cost.js";

const prices = Prices.parse({});

describe("cost formulas", () => {
  it("prices Kling clips by length", () => {
    expect(videoCost(prices, 5)).toBe(0.25);
    expect(videoCost(prices, 10)).toBe(0.5);
  });

  it("prices Flux by megapixel", () => {
    expect(imageCost(prices, { width: 1088, height: 1920 })).toBeCloseTo(0.0522, 4);
  });

  it("prices TTS by character", () => {
    expect(ttsCost(prices, 130)).toBeCloseTo(0.039, 4);
  });

  it("prices the script call from fixed token assumptions", () => {
    expect(scriptCost(prices)).toBeCloseTo(0.00545, 3);
  });
});
