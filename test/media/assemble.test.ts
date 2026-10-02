import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { concatAudio, concatVideos, finalize } from "../../src/media/assemble.js";
import { wordsToAss } from "../../src/media/captions.js";
import { countFrames, probeDuration, streamDuration } from "../../src/media/ffmpeg.js";
import { makeAudio, makeVideo, tempDir } from "../helpers/media.js";

const size = { width: 180, height: 320 };

async function scenes(dir: string) {
  const v1 = join(dir, "v1.mp4");
  const v2 = join(dir, "v2.mp4");
  await makeVideo(v1, { frames: 45, fps: 30, ...size });
  await makeVideo(v2, { frames: 46, fps: 30, ...size });
  const a1 = join(dir, "a1.wav");
  const a2 = join(dir, "a2.wav");
  await makeAudio(a1, [{ tone: 1.5 }]);
  await makeAudio(a2, [{ tone: 1.53, freq: 660 }]);
  const video = join(dir, "video.mp4");
  const narration = join(dir, "narration.wav");
  await concatVideos([v1, v2], video);
  await concatAudio([a1, a2], narration);
  const captions = join(dir, "captions.ass");
  await writeFile(captions, wordsToAss([{ text: "hello", start: 0, end: 1 }, { text: "world", start: 1.5, end: 2.5 }], size));
  return { video, narration, captions };
}

describe("assemble", () => {
  it("concatenates scenes exactly", async () => {
    const dir = await tempDir();
    const { video, narration } = await scenes(dir);
    expect(await countFrames(video)).toBe(91);
    expect(await probeDuration(narration)).toBeCloseTo(3.03, 2);
  });

  for (const withBgm of [false, true]) {
    it(`finalizes with A/V within one frame (bgm: ${withBgm})`, async () => {
      const dir = await tempDir();
      const parts = await scenes(dir);
      let bgm: string | undefined;
      if (withBgm) {
        bgm = join(dir, "bgm.wav");
        await makeAudio(bgm, [{ tone: 1, freq: 220 }]);
      }
      const out = join(dir, "final.mp4");
      await finalize({ ...parts, bgm, fontsDir: resolve("assets/fonts"), totalFrames: 91, fps: 30, out });
      expect(await countFrames(out)).toBe(91);
      const drift = Math.abs((await streamDuration(out, "v")) - (await streamDuration(out, "a")));
      expect(drift).toBeLessThanOrEqual(1 / 30);
    });
  }
});
