import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countFrames, probeVideo } from "../../src/media/ffmpeg.js";
import { applyFit, planFit } from "../../src/media/fit.js";
import { extractFrame, extractLastFrame, extractSeamFrame } from "../../src/media/frames.js";
import { frameDiff, makeVideo, tempDir } from "../helpers/media.js";

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

describe("extractSeamFrame", () => {
  // A 24 fps source fitted to 30 fps duplicates every 4th frame, so an output-side `-ss (frames-1)/30` seek
  // on the raw clip picks the wrong source frame for about half of all frame counts. The seam frame must be
  // exactly what the fitted clip shows last; flat frames make that checkable with frameDiff 0.
  for (const [frames, kind] of [[75, "trim"], [76, "trim"], [77, "trim"], [78, "trim"], [100, "slow"], [140, "slow+freeze"]] as const) {
    it(`equals the last frame of applyFit's output (${kind}, ${frames} frames)`, async () => {
      const dir = await tempDir();
      const clip = join(dir, "clip.mp4");
      await makeVideo(clip, { seconds: 3, fps: 24, width: 180, height: 320, flat: 0 });
      const plan = planFit(3, frames / 30);
      expect(plan.kind).toBe(kind);
      const fitted = join(dir, "fit.mp4");
      await applyFit(clip, fitted, plan, frames, size, 30);
      const shown = join(dir, "shown.png");
      await extractLastFrame(fitted, shown);
      const seam = join(dir, "seam.png");
      await extractSeamFrame(clip, seam, plan, frames, size, 30);
      expect(await probeVideo(seam)).toMatchObject(size);
      expect(await frameDiff(seam, shown)).toBe(0);
      if (plan.kind !== "slow+freeze") {
        // and it is not just any frame: an earlier one differs (a freeze plan ends on clones of one frame)
        const before = join(dir, "before.png");
        await extractFrame(fitted, frames - 5, before);
        expect(await frameDiff(seam, before)).toBeGreaterThan(0);
      }
    });
  }
});
