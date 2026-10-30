import { describe, expect, it } from "vitest";
import { framesAt, SOUND_MIX, sceneSoundVolume } from "../../src/media/remotion/timeline.js";

const fade = 6;
const vol = (frame: number, speech: Array<{ from: number; to: number }> = [], from = 0, frames = 60, gain = 0.8) =>
  sceneSoundVolume(frame, frames, fade, speech, 0.5, 10, gain, from);

describe("sceneSoundVolume", () => {
  it("is silent where the scene starts and where it ends, and is the gain in the middle", () => {
    expect(vol(0)).toBe(0);
    expect(vol(60)).toBe(0); // the frame after the last one
    expect(vol(30)).toBeCloseTo(0.8);
  });

  it("ramps up over the fade frames", () => {
    expect(vol(3)).toBeCloseTo(0.4);
    expect(vol(59)).toBeCloseTo(0.8 / 6);
  });

  it("is ducked to duckTo under speech, read on the video's frame and not the scene's", () => {
    const speech = [{ from: 100, to: 140 }];
    expect(vol(30, speech, 90)).toBeCloseTo(0.8 * 0.5); // global frame 120
    expect(vol(30, speech, 0)).toBeCloseTo(0.8); // global frame 30, far from speech
  });

  it("eases between over rampFrames", () => {
    const speech = [{ from: 100, to: 140 }];
    const mid = vol(35, speech, 70); // global 105 inside; 95 is five frames before
    const before = vol(25, speech, 70); // global 95
    expect(before).toBeGreaterThan(0.8 * 0.5);
    expect(before).toBeLessThan(0.8);
  });

  it("has no fade when fadeFrames is 0", () => {
    expect(sceneSoundVolume(0, 60, 0, [], 0.5, 10, 0.8)).toBeCloseTo(0.8);
  });

  it("is the same at 60 fps as at 30 for the same seconds", () => {
    const at30 = sceneSoundVolume(3, 60, SOUND_MIX.fadeFrames, [{ from: 20, to: 40 }], 0.5, SOUND_MIX.rampFrames, 1, 0);
    const at60 = sceneSoundVolume(6, 120, framesAt(SOUND_MIX.fadeFrames, 60), [{ from: 40, to: 80 }], 0.5, framesAt(SOUND_MIX.rampFrames, 60), 1, 0);
    expect(at60).toBeCloseTo(at30);
    const m30 = sceneSoundVolume(12, 60, SOUND_MIX.fadeFrames, [{ from: 20, to: 40 }], 0.5, SOUND_MIX.rampFrames, 1, 0);
    const m60 = sceneSoundVolume(24, 120, framesAt(SOUND_MIX.fadeFrames, 60), [{ from: 40, to: 80 }], 0.5, framesAt(SOUND_MIX.rampFrames, 60), 1, 0);
    expect(m60).toBeCloseTo(m30, 1);
  });
});
