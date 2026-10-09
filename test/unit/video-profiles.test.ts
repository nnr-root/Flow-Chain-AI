import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { NEW_RUN_VIDEO_PROFILE, VIDEO_PROFILES, videoProfileOf, wanFrames } from "../../src/video-profiles.js";

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

  it("gives new runs the GPU clip profile and keeps runs without a profile on kling-v1", () => {
    expect(NEW_RUN_VIDEO_PROFILE).toBe("wan22-480p@1");
    expect(videoProfileOf(undefined).id).toBe("kling-v1");
    expect(videoProfileOf("kling-v2").id).toBe("kling-v2");
  });
});

describe("wan22-480p@1", () => {
  const wan = VIDEO_PROFILES["wan22-480p@1"];
  const prices = Prices.parse({});

  it("buys only the 4k+1 frames the narration needs after a 1.25× stretch, 33 to 81", () => {
    expect([2.5, 3, 4.5, 6, 6.3, 10].map(wanFrames)).toEqual([33, 41, 61, 81, 81, 81]);
    expect(wan.clipSec(3)).toBe(41 / 16);
  });

  it("prices a clip by frames × GPU seconds per frame × $/s, plus one cold start per run", () => {
    expect(wan.costUsd(prices, 81 / 16)).toBe(0.0372); // 81 × 1.5 s × $0.000306
    expect(wan.runOverheadUsd(prices)).toBe(0.0275); // 90 s × $0.000306
    expect(VIDEO_PROFILES["kling-v2"].runOverheadUsd(prices)).toBe(0);
  });

  it("prices a 720p clip by its own seconds a frame, for the same lengths as a 480p one", () => {
    const prices = Prices.parse({});
    const [sd, hd] = [VIDEO_PROFILES["wan22-480p@1"], VIDEO_PROFILES["wan22-720p@1"]];
    for (const narration of [1, 3.2, 5, 9]) expect(hd.clipSec(narration)).toBe(sd.clipSec(narration));
    // 65 frames: 157 s measured on the card the endpoint runs on
    expect(hd.costUsd(prices, 65 / 16)).toBe(0.0497);
    expect(hd.costUsd(prices, 65 / 16)).toBeGreaterThan(sd.costUsd(prices, 65 / 16) * 1.5);
    expect([sd.clipHeight, hd.clipHeight]).toEqual([undefined, 720]);
    expect(hd.runOverheadUsd(prices)).toBe(sd.runOverheadUsd(prices));
    expect(hd.costUsd(Prices.parse({ runpodClip720SecPerFrame: 1 }), 65 / 16)).toBe(0.0199);
  });
});
