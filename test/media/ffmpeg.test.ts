import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clipDuration, countFrames, ffmpeg, FfmpegError, probeDuration, probeVideo, streamDuration } from "../../src/media/ffmpeg.js";
import { makeAudio, makeVideo, tempDir } from "../helpers/media.js";

describe("ffmpeg wrapper", () => {
  it("probes generated video", async () => {
    const dir = await tempDir();
    const v = join(dir, "v.mp4");
    await makeVideo(v, { seconds: 2, fps: 30 });
    expect(await countFrames(v)).toBe(60);
    expect(await probeVideo(v)).toEqual({ width: 320, height: 240, fps: 30 });
    expect(await streamDuration(v, "v")).toBeCloseTo(2, 2);
  });

  it("probes generated audio", async () => {
    const dir = await tempDir();
    const a = join(dir, "a.wav");
    await makeAudio(a, [{ tone: 1 }, { silence: 0.5 }]);
    expect(await probeDuration(a)).toBeCloseTo(1.5, 2);
  });

  it("measures a clip by its picture when its sound runs a few ms longer, and a clip without sound as it always was", async () => {
    const dir = await tempDir();
    const silent = join(dir, "silent.mp4");
    await makeVideo(silent, { frames: 49, fps: 24 });
    expect(await clipDuration(silent)).toBe(await probeDuration(silent));
    const withSound = join(dir, "sound.mp4");
    await ffmpeg([
      "-i", silent, "-f", "lavfi", "-t", String(49 / 24 + 0.06), "-i", "sine=f=440:sample_rate=48000",
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", withSound,
    ]);
    expect(await probeDuration(withSound)).toBeGreaterThan(49 / 24 + 0.03);
    expect(await clipDuration(withSound)).toBeCloseTo(49 / 24, 3);
  });

  it("throws FfmpegError with stderr on failure", async () => {
    await expect(ffmpeg(["-i", "/nonexistent.mp4", "/tmp/x.mp4"])).rejects.toBeInstanceOf(FfmpegError);
  });
});
