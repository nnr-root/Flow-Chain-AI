import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { probeVideo } from "../../src/media/ffmpeg.js";
import { type RunOptions, planRun, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { STAGES } from "../../src/stages/index.js";
import { upscaleCost, upscaleStage } from "../../src/stages/upscale.js";
import { fitStage } from "../../src/stages/fit.js";
import { join } from "node:path";
import { fileSha256 } from "../../src/manifest/hash.js";
import { FakeUpscale } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 8 spec §8: full HD, every moving clip upscaled before it is fitted.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

async function hdRun() {
  const made = await makeTestContext({ modes: [1, 1, 2], shots: ["cut", "continue", "cut"] });
  const upscale = new FakeUpscale(join(made.dir, "_fakes"));
  made.ctx.providers = { ...made.ctx.providers, upscale };
  made.ctx.manifest.request.upscale = true;
  made.ctx.manifest.models.upscale = "runpod:ep-up/upscale-seedvr2@1";
  return { ...made, upscale };
}

describe("a run in full HD", () => {
  it("upscales every moving clip, once, fits the upscaled one, and pays for each", async () => {
    const { ctx, upscale } = await hdRun();
    await runPipeline(ctx, STAGES, auto);
    // the two clips, not the still
    expect(upscale.submits.map((r) => r.videoPath.split("/").at(-1))).toEqual(["clip_01.mp4", "clip_02.mp4"]);
    expect(upscale.submits.every((r) => r.short === 1080)).toBe(true);
    const m = ctx.manifest;
    expect(m.scenes[0].upscaled?.path).toBe("clips/clip_01.hd.mp4");
    expect(m.scenes[2].upscaled).toBeUndefined();
    expect(m.ledger.filter((e) => e.stage === "upscale").map((e) => e.scene)).toEqual([0, 1]);
    // the first pays for the worker's start
    expect(m.ledger.find((e) => e.stage === "upscale" && e.scene === 0)!.usd).toBeGreaterThan(m.ledger.find((e) => e.stage === "upscale" && e.scene === 1)!.usd);
    // what is fitted is the full HD clip (scaled to the run's size, as every clip is)
    expect(((await fitStage.inputsFor(ctx, 0)) as { clip: string }).clip).toBe(await fileSha256(join(ctx.dir, "clips/clip_01.hd.mp4")));
    expect((await probeVideo(join(ctx.dir, m.scenes[0].upscaled!.path))).height).toBe(1080);
    // and a resume buys nothing again
    expect((await planRun(ctx, STAGES)).items).toEqual([]);
  });

  it("upscales a clip again only when the clip is made again", async () => {
    const { ctx, upscale } = await hdRun();
    await runPipeline(ctx, STAGES, auto);
    bumpNonce(ctx.manifest, 2, "clips");
    const plan = await planRun(ctx, STAGES);
    // scene 2's clip is made again, and so its full HD one; scene 1's stays
    expect(plan.items.filter((i) => i.stage === "upscale").map((i) => i.scene)).toEqual([1]);
    await runPipeline(ctx, STAGES, auto);
    expect(upscale.submits).toHaveLength(3);
  });

  it("asks again, after a failed upscale, only when that scene's upscale is rerolled", async () => {
    const { ctx, upscale } = await hdRun();
    upscale.unusable = (r) => r.videoPath.endsWith("clip_01.mp4");
    await expect(runPipeline(ctx, STAGES, auto)).rejects.toThrow(/full HD scene 1/);
    // the failed request is kept: a resume asks for the same one, never a new one
    upscale.unusable = undefined;
    const asked = upscale.submits.length;
    expect(() => bumpNonce(ctx.manifest, 3, "upscale")).toThrow(/no full HD clip/);
    bumpNonce(ctx.manifest, 1, "upscale");
    await runPipeline(ctx, STAGES, auto);
    expect(upscale.submits.length).toBe(asked + 2);
    expect(ctx.manifest.scenes[0].upscaled).toBeDefined();
  });

  it("is a step only a run that asked for it has, keyed so that no earlier run's fit changes", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1] });
    expect(upscaleStage.appliesTo!(ctx.manifest, 0)).toBe(false);
    await runPipeline(ctx, STAGES, auto);
    expect(ctx.manifest.ledger.some((e) => e.stage === "upscale")).toBe(false);
    expect(ctx.manifest.scenes[0].upscaled).toBeUndefined();
  });

  it("is priced from the GPU seconds measured for each second of clip, and the worker's start once", () => {
    const p = Prices.parse({});
    expect(upscaleCost(p, 5)).toBeCloseTo(5 * 110 * 0.000306, 4);
    expect(upscaleCost(p, 5, true)).toBeCloseTo((5 * 110 + 20) * 0.000306, 4);
    // what the endpoint really billed on 2026-10-16: $0.1072 for a clip of 3.28 s, $0.141 for one of 4.28 s
    expect(Math.abs(upscaleCost(p, 3.28125) - 0.1072)).toBeLessThan(0.005);
    expect(Math.abs(upscaleCost(p, 4.28125) - 0.141)).toBeLessThan(0.005);
  });
});
