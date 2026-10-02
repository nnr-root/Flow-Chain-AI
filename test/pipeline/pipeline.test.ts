import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadManifest } from "../../src/manifest/store.js";
import { cellSize } from "../../src/media/contact-sheet.js";
import { countFrames, probeVideo, streamDuration } from "../../src/media/ffmpeg.js";
import { type Plan, planRun, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { STAGES } from "../../src/stages/index.js";
import { abs, paths } from "../../src/stages/paths.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("end-to-end with fakes", () => {
  it("renders a hybrid 1,2,1,1 video with a 4-row chain sheet", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 2, 1, 1], shots: ["cut", "continue", "continue", "cut"] });
    await runPipeline(ctx, STAGES, auto);
    const final = abs(ctx, paths.final);
    const total = ctx.manifest.scenes.reduce((a, s) => a + s.audio!.duration, 0);
    expect(await countFrames(final)).toBe(Math.round(total * 30));
    const drift = Math.abs((await streamDuration(final, "v")) - (await streamDuration(final, "a")));
    expect(drift).toBeLessThanOrEqual(1 / 30);
    const cell = cellSize(ctx.size);
    const sheet = await probeVideo(abs(ctx, paths.chain));
    expect(sheet.height).toBe(cell.height * 4);
  });

  it("resumes after a failed clip without repeating any completed paid call", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1, 1] });
    fakes.video.failWhen = (req) => basename(req.imagePath) === "last_02.png"; // scene 3's chain image
    await expect(runPipeline(ctx, STAGES, auto)).rejects.toThrow(/clip scene 3 failed after 3 attempts/);
    expect(fakes.video.calls).toHaveLength(5); // scenes 1, 2, then 3 attempts at scene 3

    const saved = await loadManifest(ctx.dir);
    expect(saved.scenes[2].stages.clips?.status).toBe("failed");

    fakes.video.failWhen = undefined;
    await runPipeline({ ...ctx, manifest: saved }, STAGES, auto);
    expect(fakes.llm.calls).toHaveLength(1);
    expect(fakes.tts.calls).toHaveLength(4);
    expect(fakes.image.calls).toHaveLength(1);
    expect(fakes.video.calls).toHaveLength(7); // + scenes 3 and 4
    expect((await loadManifest(ctx.dir)).final).toBeDefined();
  });

  it("a clip reroll cascades down the chain and stops at the next cut", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1, 1], shots: ["cut", "continue", "continue", "cut"] });
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.calls).toHaveLength(2);
    expect(fakes.video.calls).toHaveLength(4);

    bumpNonce(ctx.manifest, 2, "clips");
    const plan = await planRun(ctx, STAGES);
    expect(plan.items.filter((i) => i.costUsd > 0).map((i) => [i.stage, i.scene])).toEqual([
      ["clips", 1],
      ["clips", 2],
    ]);

    const confirm = vi.fn(async () => true);
    await runPipeline(ctx, STAGES, { budgetUsd: 100, confirm, reroll: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fakes.video.calls.slice(4).map((c) => basename(c.imagePath))).toEqual(["last_01.png", "last_02.png"]);
    expect(fakes.image.calls).toHaveLength(2);
    expect(fakes.tts.calls).toHaveLength(4);
  });

  it("the media checkpoint estimate equals what the ledger records", async () => {
    const plans: Array<[string, Plan]> = [];
    const { ctx } = await makeTestContext({ modes: [1, 2, 1] });
    await runPipeline(ctx, STAGES, { ...auto, onPlan: (p, label) => plans.push([label, p]) });
    const media = plans.find(([label]) => label === "Media plan")![1];
    const spent = ctx.manifest.ledger
      .filter((e) => e.stage === "keyframes" || e.stage === "clips")
      .reduce((a, e) => a + e.usd, 0);
    expect(spent).toBeCloseTo(media.totalUsd, 6);
    expect(media.totalUsd).toBeGreaterThan(0);
  });
});
