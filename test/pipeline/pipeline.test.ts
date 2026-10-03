import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadManifest } from "../../src/manifest/store.js";
import { cellSize } from "../../src/media/contact-sheet.js";
import { extractLastFrame } from "../../src/media/frames.js";
import { countFrames, probeVideo, streamDuration } from "../../src/media/ffmpeg.js";
import { type Plan, planRun, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { STAGES } from "../../src/stages/index.js";
import { abs, paths } from "../../src/stages/paths.js";
import { makeTestContext } from "../helpers/context.js";
import { frameDiff } from "../helpers/media.js";

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

  it("resumes after a rejected clip submission without repeating any completed paid call", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1, 1] });
    fakes.video.failSubmit = (req) => req.prompt.startsWith("motion 3");
    await expect(runPipeline(ctx, STAGES, auto)).rejects.toThrow(/clip scene 3 \(submit\) failed after 1 attempt/);
    expect(fakes.video.submits).toHaveLength(2); // a submit is never retried

    const saved = await loadManifest(ctx.dir);
    expect(saved.scenes[2].stages.clips?.status).toBe("failed");
    expect(saved.scenes[2].jobs.clips).toBeUndefined();

    fakes.video.failSubmit = undefined;
    await runPipeline({ ...ctx, manifest: saved }, STAGES, auto);
    expect(fakes.llm.calls).toHaveLength(1);
    expect(fakes.tts.calls).toHaveLength(4);
    expect(fakes.image.submits).toHaveLength(1);
    expect(fakes.video.submits).toHaveLength(4); // + scenes 3 and 4
    const final = await loadManifest(ctx.dir);
    expect(final.final).toBeDefined();
    expect(final.ledger.filter((e) => e.stage === "clips")).toHaveLength(4);
  });

  it("a clip reroll cascades down the chain and stops at the next cut", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1, 1], shots: ["cut", "continue", "continue", "cut"] });
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.submits).toHaveLength(2);
    expect(fakes.video.submits).toHaveLength(4);

    bumpNonce(ctx.manifest, 2, "clips");
    const plan = await planRun(ctx, STAGES);
    expect(plan.items.filter((i) => i.costUsd > 0).map((i) => [i.stage, i.scene])).toEqual([
      ["clips", 1],
      ["clips", 2],
    ]);

    const confirm = vi.fn(async () => true);
    await runPipeline(ctx, STAGES, { budgetUsd: 100, confirm, reroll: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fakes.video.submits.slice(4).map((c) => basename(c.imagePath))).toEqual(["seam_01.png", "seam_02.png"]);
    expect(fakes.image.submits).toHaveLength(2);
    expect(fakes.tts.calls).toHaveLength(4);
  });

  it("starts a continuing clip from exactly the last frame viewers see of the previous fitted clip", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1], shots: ["cut", "continue"] });
    await runPipeline(ctx, STAGES, auto);
    expect(ctx.manifest.scenes[0].fitted?.plan.kind).toBe("trim"); // 5 s clip cut to ~2.6 s of audio

    const sent = fakes.video.submits[1].imagePath;
    expect(sent).toBe(abs(ctx, paths.seam(0)));
    const shown = abs(ctx, "shown.png");
    await extractLastFrame(abs(ctx, paths.fitted(0)), shown);
    expect(await frameDiff(sent, shown)).toBe(0);
    // the raw clip's last frame, which viewers never see, is not what scene 2 starts from
    const rawLast = abs(ctx, "raw_last.png");
    await extractLastFrame(abs(ctx, paths.clip(0)), rawLast);
    expect(await frameDiff(rawLast, shown)).toBeGreaterThan(0);
    // chain.png's right column is the fitted last frame too
    expect(await frameDiff(abs(ctx, paths.lastFrame(0)), shown)).toBe(0);
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
