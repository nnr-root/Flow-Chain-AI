import { describe, expect, it } from "vitest";
import { LTX_RATES_MISSING, Prices } from "../../src/config.js";
import { LTX_FPS, ltxFrames, NEW_RUN_VIDEO_PROFILE, VIDEO_PROFILES, videoProfileOf, wanFrames } from "../../src/video-profiles.js";

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
    expect(wan.costUsd(prices, 81 / 16)).toBe(0.0248); // 81 × 1.0 s × $0.000306
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

describe("ltx25@1", () => {
  const ltx = VIDEO_PROFILES["ltx25@1"];
  const prices = Prices.parse({ runpodLtxUsdPerSec: 0.00016, runpodLtxSecPerClipSec: 29, runpodLtxColdStartSec: 120 });

  it("buys 8k+1 frames from 49 to 361 that cover the narration after a 1.25x stretch", () => {
    for (const s of [0.3, ...Array.from({ length: 20 }, (_, i) => i + 1)]) {
      const f = ltxFrames(s);
      expect((f - 1) % 8).toBe(0);
      expect(f).toBeGreaterThanOrEqual(49);
      expect(f).toBeLessThanOrEqual(361);
      expect((f / LTX_FPS) * 1.25 + 1e-9).toBeGreaterThanOrEqual(Math.min(s, 15 * 1.25));
    }
  });

  it("asks for the longest clip when the narration is longer than one clip can cover", () => {
    expect(ltxFrames(18.75)).toBe(361);
    expect(ltxFrames(25)).toBe(361);
    expect(ltxFrames(0.3)).toBe(49);
  });

  it("is a 24 fps profile generated at 640 on the short side", () => {
    expect(ltx.clipSec(5)).toBe(ltxFrames(5) / 24);
    expect(ltx.clipHeight).toBe(640);
    expect(videoProfileOf("ltx25@1").id).toBe("ltx25@1");
  });

  it("prices a clip by the GPU seconds a clip second takes and a cold start once per run", () => {
    expect(ltx.costUsd(prices, 5.04)).toBe(Math.round(5.04 * 29 * 0.00016 * 1e4) / 1e4);
    expect(ltx.runOverheadUsd(prices)).toBe(Math.round(120 * 0.00016 * 1e4) / 1e4);
  });

  it("refuses to price a clip while a rate is missing", () => {
    expect(() => ltx.costUsd(Prices.parse({}), 5)).toThrow(LTX_RATES_MISSING);
    expect(() => ltx.runOverheadUsd(Prices.parse({}))).toThrow(LTX_RATES_MISSING);
  });

  it("still resolves a manifest made on a Wan profile", () => {
    expect(videoProfileOf("wan22-480p@1").id).toBe("wan22-480p@1");
  });
});
