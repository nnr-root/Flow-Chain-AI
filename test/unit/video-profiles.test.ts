import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { NEW_RUN_VIDEO_PROFILE, VIDEO_PROFILES, videoProfileOf } from "../../src/video-profiles.js";

describe("video profiles", () => {
  it("kling-v1 (runs made before 2.3) buys 5 s up to 5.0 s of narration, else 10 s", () => {
    const p = VIDEO_PROFILES["kling-v1"];
    expect([3, 5, 5.01, 6, 6.01].map((s) => p.clipSec(s))).toEqual([5, 5, 10, 10, 10]);
  });

  it("kling-v2 buys 5 s up to 6.0 s of narration (the fit step stretches it), else 10 s", () => {
    const p = VIDEO_PROFILES["kling-v2"];
    expect([3, 5, 5.01, 6, 6.01].map((s) => p.clipSec(s))).toEqual([5, 5, 5, 5, 10]);
  });

  it("prices clips with the Kling table", () => {
    const prices = Prices.parse({});
    expect(VIDEO_PROFILES["kling-v2"].costUsd(prices, 5)).toBe(0.25);
    expect(VIDEO_PROFILES["kling-v2"].costUsd(prices, 10)).toBe(0.5);
  });

  it("gives new runs kling-v2 and runs without a profile kling-v1", () => {
    expect(NEW_RUN_VIDEO_PROFILE).toBe("kling-v2");
    expect(videoProfileOf(undefined).id).toBe("kling-v1");
    expect(videoProfileOf("kling-v2").id).toBe("kling-v2");
  });
});
