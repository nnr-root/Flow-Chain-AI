import { describe, expect, it } from "vitest";
import { IMAGE_PROFILES } from "../../src/image-profiles.js";
import { clipsStage } from "../../src/stages/clips.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { VIDEO_PROFILES } from "../../src/video-profiles.js";
import { runPipeline } from "../../src/pipeline.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { makeTestContext } from "../helpers/context.js";

describe("RunPod estimates", () => {
  it("charge each endpoint's cold start to its first job of the run only", async () => {
    const { ctx } = await makeTestContext({ modes: [2, 1, 1] }); // keyframes: scenes 1-3; clips: scenes 2-3
    ctx.manifest.request.imageProfile = "runpod-sdxl@1";
    ctx.manifest.request.videoProfile = "wan22-480p@1";
    const image = IMAGE_PROFILES["runpod-sdxl@1"];
    const video = VIDEO_PROFILES["wan22-480p@1"];
    const keyframe = image.keyframeUsd(ctx.prices, ctx.keyframeSize);
    expect(keyframesStage.estimateCostUsd(ctx, 0)).toBe(keyframe + image.runOverheadUsd(ctx.prices));
    expect(keyframesStage.estimateCostUsd(ctx, 2)).toBe(keyframe);
    const longest = video.costUsd(ctx.prices, video.clipSec(Number.POSITIVE_INFINITY)); // no audio yet
    expect(clipsStage.estimateCostUsd(ctx, 1)).toBe(longest + video.runOverheadUsd(ctx.prices));
    expect(clipsStage.estimateCostUsd(ctx, 2)).toBe(longest);
  });

  it("leave fal and Kling runs priced as before (no overhead)", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1] });
    expect(keyframesStage.estimateCostUsd(ctx, 0)).toBe(IMAGE_PROFILES["fal-flux@1"].keyframeUsd(ctx.prices, ctx.keyframeSize));
    expect(clipsStage.estimateCostUsd(ctx, 0)).toBe(0.5); // kling-v1 before audio: the 10 s clip
  });

  it("ask the clip worker for 720p only in a run that chose it, and price such a clip by its own rate", async () => {
    const hd = await makeTestContext({ modes: [1, 1] });
    hd.ctx.manifest.request.videoProfile = "wan22-720p@1";
    const sd = await makeTestContext({ modes: [1, 1] });
    sd.ctx.manifest.request.videoProfile = "wan22-480p@1";
    expect(clipsStage.estimateCostUsd(hd.ctx, 1)).toBeGreaterThan(clipsStage.estimateCostUsd(sd.ctx, 1) * 1.5);
    for (const { ctx, fakes } of [hd, sd]) await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], { budgetUsd: 100, confirm: async () => true });
    expect(hd.fakes.video.submits.map((r) => r.height)).toEqual([720, 720]);
    expect(sd.fakes.video.submits.every((r) => !("height" in r))).toBe(true);
    // the size is part of what is bought, so part of a 720p clip's cache key; a 480p run's key is as it always was
    expect(await clipsStage.inputsFor(hd.ctx, 0)).toMatchObject({ height: 720 });
    expect(await clipsStage.inputsFor(sd.ctx, 0)).not.toHaveProperty("height");
  });
});
