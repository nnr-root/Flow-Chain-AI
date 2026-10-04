import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cellSize } from "../../src/media/contact-sheet.js";
import { countFrames, ffmpeg, probeVideo, streamDuration } from "../../src/media/ffmpeg.js";
import { extractFrame, extractLastFrame } from "../../src/media/frames.js";
import { type RunOptions, runPipeline } from "../../src/pipeline.js";
import { STAGES } from "../../src/stages/index.js";
import { abs, paths } from "../../src/stages/paths.js";
import { sceneFrames } from "../../src/stages/visual.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

/** Mean luma difference of the top halves of two same-size images (captions live in the bottom half). */
async function topHalfDiff(a: string, b: string): Promise<number> {
  const log = await ffmpeg(
    ["-i", a, "-i", b, "-filter_complex",
      "[0:v]crop=iw:ih/2:0:0,format=yuv420p[x];[1:v]crop=iw:ih/2:0:0,format=yuv420p[y];" +
        "[x][y]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
      "-f", "null", "-"],
    { logLevel: "info" },
  );
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(log);
  if (!m) throw new Error("no YAVG in ffmpeg output");
  return Number(m[1]);
}

describe("render stage (real Chrome)", () => {
  it("renders a hybrid run frame-exactly and keeps the continue seam a faithful hard cut", async () => {
    // scene 2 is Mode 2 (cut), scene 3 follows a Mode 2 scene (cut), scene 4 continues scene 3 (seam)
    const { ctx } = await makeTestContext({ modes: [1, 2, 1, 1], shots: ["cut", "cut", "cut", "continue"] });
    await runPipeline(ctx, STAGES, auto);

    const final = abs(ctx, paths.final);
    const totalFrames = Math.round(ctx.manifest.scenes.reduce((a, s) => a + s.audio!.duration, 0) * 30);
    expect(await countFrames(final)).toBe(totalFrames);
    expect(await probeVideo(final)).toEqual({ width: 180, height: 320, fps: 30 });
    expect(Math.abs((await streamDuration(final, "v")) - (await streamDuration(final, "a")))).toBeLessThanOrEqual(1 / 30);
    expect(ctx.manifest.final).toEqual({ path: "final.mp4", duration: totalFrames / 30, chain: "chain.png" });

    // The seam: the last frame of scene 3 and the first of scene 4 in final.mp4 are the fitted clips' frames.
    const seamFrame = sceneFrames(ctx.manifest, 30).slice(0, 3).reduce((a, b) => a + b, 0);
    const dir = ctx.dir;
    await extractFrame(final, seamFrame - 1, join(dir, "f_before.png"));
    await extractFrame(final, seamFrame, join(dir, "f_after.png"));
    await extractLastFrame(abs(ctx, paths.fitted(2)), join(dir, "fit3_last.png"));
    await extractFrame(abs(ctx, paths.fitted(3)), 0, join(dir, "fit4_first.png"));
    expect(await topHalfDiff(join(dir, "f_before.png"), join(dir, "fit3_last.png"))).toBeLessThan(2);
    expect(await topHalfDiff(join(dir, "f_after.png"), join(dir, "fit4_first.png"))).toBeLessThan(2);

    const cell = cellSize(ctx.size);
    const sheet = await probeVideo(abs(ctx, paths.chain));
    expect({ width: sheet.width, height: sheet.height }).toEqual({ width: cell.width * 2, height: cell.height * 4 });
  });

});
