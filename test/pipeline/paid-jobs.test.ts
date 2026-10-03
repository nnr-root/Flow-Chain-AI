import { describe, expect, it } from "vitest";
import { imageCost, videoCost } from "../../src/cost.js";
import { loadManifest } from "../../src/manifest/store.js";
import { type RunOptions, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { clipsStage } from "../../src/stages/clips.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const VISUAL = [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage];

const charges = (m: { ledger: Array<{ stage: string; scene?: number; usd: number }> }, stage: string) =>
  m.ledger.filter((e) => e.stage === stage);

describe("paid provider jobs are bought once", () => {
  it("a video wait failure keeps the request id; resume polls it again instead of submitting a second job", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1] });
    fakes.video.failWait = (req) => req.prompt.startsWith("motion 2");
    await expect(runPipeline(ctx, VISUAL, auto)).rejects.toThrow(
      /clip scene 2 failed after 3 attempts: fake wait failure.*req-2 is kept/,
    );
    expect(fakes.video.submits).toHaveLength(2);
    expect(fakes.video.waits).toEqual(["req-1", "req-2", "req-2", "req-2"]); // polling retried, never resubmitted

    const saved = await loadManifest(ctx.dir);
    expect(saved.scenes[1].jobs.clips).toMatchObject({ requestId: "req-2", chargedUsd: 0 });
    expect(saved.scenes[1].jobs.clips?.result).toBeUndefined();
    expect(saved.scenes[1].stages.clips).toMatchObject({ status: "failed", costUsd: 0 });
    expect(charges(saved, "clips").map((e) => e.scene)).toEqual([0]);

    fakes.video.failWait = undefined;
    await runPipeline({ ...ctx, manifest: saved }, VISUAL, auto);
    expect(fakes.video.submits).toHaveLength(3); // only scene 3 is new
    expect(fakes.video.waits.slice(4)).toEqual(["req-2", "req-3"]);
    const done = await loadManifest(ctx.dir);
    expect(charges(done, "clips").map((e) => e.scene)).toEqual([0, 1, 2]);
    expect(done.scenes[1].stages.clips).toMatchObject({ status: "done", costUsd: videoCost(ctx.prices, 5) });
  });

  it("a post-processing failure after a successful job is charged once; resume re-downloads without the provider", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1] });
    fakes.video.withhold = (req) => req.prompt.startsWith("motion 2");
    await expect(runPipeline(ctx, VISUAL, auto)).rejects.toThrow(/clip_02|vid_2|ENOENT/);

    const saved = await loadManifest(ctx.dir);
    expect(charges(saved, "clips").map((e) => e.scene)).toEqual([0, 1]); // charged before the download
    expect(saved.scenes[1].jobs.clips?.result?.url).toMatch(/vid_2\.mp4$/);
    expect(saved.scenes[1].stages.clips).toMatchObject({ status: "failed", costUsd: videoCost(ctx.prices, 5) });

    await fakes.video.release();
    await runPipeline({ ...ctx, manifest: saved }, VISUAL, auto);
    expect(fakes.video.submits).toHaveLength(2);
    expect(fakes.video.waits).toEqual(["req-1", "req-2"]); // the provider is not called again
    const done = await loadManifest(ctx.dir);
    expect(charges(done, "clips")).toHaveLength(2);
    expect(done.scenes[1].clip?.duration).toBeGreaterThan(4.9);
    expect(done.scenes[1].stages.clips).toMatchObject({ status: "done", costUsd: videoCost(ctx.prices, 5) });
  });

  it("an unusable (NSFW) keyframe is charged once, not retried, and only a reroll submits a new job", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1], shots: ["cut", "cut"] });
    fakes.image.unusable = (req) => req.prompt.endsWith("image 2");
    const failure = /keyframe scene 2 failed after 1 attempt: fake request req-2 flagged NSFW/;
    await expect(runPipeline(ctx, VISUAL, auto)).rejects.toThrow(failure);
    expect(fakes.image.waits).toEqual(["req-1", "req-2"]);
    expect(charges(ctx.manifest, "keyframes").map((e) => e.scene)).toEqual([0, 1]);

    // resuming polls the same completed request again: same error, no new submit, no second charge
    await expect(runPipeline(ctx, VISUAL, auto)).rejects.toThrow(failure);
    expect(fakes.image.submits).toHaveLength(2);
    expect(charges(ctx.manifest, "keyframes")).toHaveLength(2);

    fakes.image.unusable = undefined;
    bumpNonce(ctx.manifest, 2, "keyframes");
    await runPipeline(ctx, VISUAL, { ...auto, reroll: true });
    expect(fakes.image.submits).toHaveLength(3);
    expect(charges(ctx.manifest, "keyframes").map((e) => e.usd)).toEqual(
      [0, 1, 1].map(() => imageCost(ctx.prices, ctx.keyframeSize)),
    );
  });
});
