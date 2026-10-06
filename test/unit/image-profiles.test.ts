import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { imageCost } from "../../src/cost.js";
import { IMAGE_PROFILES, imageProfileOf } from "../../src/image-profiles.js";

const prices = Prices.parse({});
const size = { width: 1088, height: 1920 };

describe("image profiles", () => {
  it("keeps runs made before 2.4 on fal's per-megapixel price, with no reference and no overhead", () => {
    const fal = imageProfileOf(undefined);
    expect(fal.id).toBe("fal-flux@1");
    expect(fal.keyframeUsd(prices, size)).toBe(imageCost(prices, size));
    expect([fal.referenceUsd(prices, size), fal.runOverheadUsd(prices)]).toEqual([0, 0]);
  });

  it("prices the RunPod SDXL worker by GPU seconds: 8 s per keyframe and reference, a 90 s cold start once", () => {
    const sdxl = IMAGE_PROFILES["runpod-sdxl@1"];
    expect(sdxl.keyframeUsd(prices, size)).toBe(0.0024); // 8 s × $0.000306
    expect(sdxl.referenceUsd(prices, size)).toBe(0.0024);
    expect(sdxl.runOverheadUsd(prices)).toBe(0.0275); // 90 s × $0.000306
  });

  it("uses prices.json overrides", () => {
    const custom = Prices.parse({ runpodKeyframeUsdPerSec: 0.001, runpodKeyframeSec: 5 });
    expect(IMAGE_PROFILES["runpod-sdxl@1"].keyframeUsd(custom, size)).toBe(0.005);
  });
});
