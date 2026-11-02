import { describe, expect, it } from "vitest";
import { VIDEO_PROFILES, wanFrames } from "../../src/video-profiles.js";

/**
 * Wan is gone (phase 15 spec §13.10), but every run made on it has `requestedSec` in its clips' keys and in its modes
 * stage's: a length that moved by a frame would make a finished run's free re-render stale. These literals were read
 * from the code before Wan was removed and must never change.
 */
describe("an old Wan run's clip lengths", () => {
  it("are the frames and seconds they were when its clips were bought, for one to six seconds of narration", () => {
    expect([1, 2, 3, 4, 5, 6].map(wanFrames)).toEqual([33, 33, 41, 53, 65, 81]);
    const seconds = [2.0625, 2.0625, 2.5625, 3.3125, 4.0625, 5.0625];
    expect([1, 2, 3, 4, 5, 6].map((s) => VIDEO_PROFILES["wan22-480p@1"].clipSec(s))).toEqual(seconds);
    expect([1, 2, 3, 4, 5, 6].map((s) => VIDEO_PROFILES["wan22-720p@1"].clipSec(s))).toEqual(seconds);
  });

  it("keep the 720p run's size in its keys and give the 480p run none, as when they were bought", () => {
    expect(VIDEO_PROFILES["wan22-720p@1"].clipHeight).toBe(720);
    expect(VIDEO_PROFILES["wan22-480p@1"].clipHeight).toBeUndefined();
  });
});
