import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countFrames, probeVideo } from "../../src/media/ffmpeg.js";
import { applyFit, planFit } from "../../src/media/fit.js";
import { makeVideo, tempDir } from "../helpers/media.js";

const size = { width: 180, height: 320 };

describe("applyFit", () => {
  for (const [target, kind] of [[2, "trim"], [3.5, "slow"], [6, "slow+freeze"]] as const) {
    it(`produces exactly target frames for a ${kind} plan`, async () => {
      const dir = await tempDir();
      const clip = join(dir, "clip.mp4");
      await makeVideo(clip, { seconds: 3, fps: 24, width: 320, height: 240 });
      const plan = planFit(3, target);
      expect(plan.kind).toBe(kind);
      const out = join(dir, "fit.mp4");
      const frames = Math.round(target * 30);
      await applyFit(clip, out, plan, frames, size, 30);
      expect(await countFrames(out)).toBe(frames);
      expect(await probeVideo(out)).toEqual({ ...size, fps: 30 });
    });
  }
});
