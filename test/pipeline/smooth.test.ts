import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileSha256 } from "../../src/manifest/hash.js";
import { probeVideo } from "../../src/media/ffmpeg.js";
import { type RunOptions, planRun, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { fitStage } from "../../src/stages/fit.js";
import { STAGES } from "../../src/stages/index.js";
import { interpolateStage, isSmoothed } from "../../src/stages/interpolate.js";
import { upscaleStage } from "../../src/stages/upscale.js";
import { FakeUpscale } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 11 spec §4: 60 fps. A moving clip is interpolated (and, in Full HD, upscaled in the same job) before it is fitted.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const RATES = { runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 };

async function smoothRun(opts: { fullHd?: boolean } = {}) {
  const made = await makeTestContext({ modes: [1, 1, 2], shots: ["cut", "continue", "cut"] });
  const restore = new FakeUpscale(join(made.dir, "_fakes"));
  made.ctx.providers = { ...made.ctx.providers, upscale: restore };
  Object.assign(made.ctx.prices, RATES);
  made.ctx.fps = 60;
  made.ctx.manifest.request.fps = 60;
  if (opts.fullHd) made.ctx.manifest.request.upscale = true;
  made.ctx.manifest.models.upscale = "runpod:ep-up/restore-video@1";
  return { ...made, restore };
}

describe("a run in smooth motion without Full HD", () => {
  it("interpolates every moving clip once, fits the smoothed one at 60, and pays for each", async () => {
    const { ctx, restore } = await smoothRun();
    await runPipeline(ctx, STAGES, auto);
    expect(restore.submits.map((r) => r.videoPath.split("/").at(-1))).toEqual(["clip_01.mp4", "clip_02.mp4"]);
    expect(restore.submits.every((r) => r.short === undefined && r.interpolate === 2)).toBe(true);
    const m = ctx.manifest;
    expect(m.scenes[0].smoothed?.path).toBe("clips/clip_01.60.mp4");
    expect(m.scenes[2].smoothed).toBeUndefined();
    expect(m.scenes[0].upscaled).toBeUndefined();
    expect(m.ledger.filter((e) => e.stage === "interpolate").map((e) => e.scene)).toEqual([0, 1]);
    // the first pays for the worker's start
    expect(m.ledger.find((e) => e.stage === "interpolate" && e.scene === 0)!.usd).toBeGreaterThan(m.ledger.find((e) => e.stage === "interpolate" && e.scene === 1)!.usd);
    // what is fitted is the smoothed clip, at the run's 60
    expect(((await fitStage.inputsFor(ctx, 0)) as { clip: string }).clip).toBe(await fileSha256(join(ctx.dir, "clips/clip_01.60.mp4")));
    const clip = await probeVideo(join(ctx.dir, "clips/clip_01.mp4"));
    expect((await probeVideo(join(ctx.dir, m.scenes[0].smoothed!.path))).fps).toBeCloseTo(clip.fps * 2, 0);
    expect((await probeVideo(join(ctx.dir, m.scenes[0].fitted!.path))).fps).toBe(60);
    // and a resume buys nothing again
    expect((await planRun(ctx, STAGES)).items).toEqual([]);
  });

  it("interpolates a clip again only when the clip is made again", async () => {
    const { ctx, restore } = await smoothRun();
    await runPipeline(ctx, STAGES, auto);
    bumpNonce(ctx.manifest, 2, "clips");
    const plan = await planRun(ctx, STAGES);
    expect(plan.items.filter((i) => i.stage === "interpolate").map((i) => i.scene)).toEqual([1]);
    await runPipeline(ctx, STAGES, auto);
    expect(restore.submits).toHaveLength(3);
  });
});

describe("a run in Full HD and smooth motion", () => {
  it("does both in ONE job per clip and has no interpolate step of its own", async () => {
    const { ctx, restore } = await smoothRun({ fullHd: true });
    await runPipeline(ctx, STAGES, auto);
    expect(restore.submits).toHaveLength(2);
    expect(restore.submits.every((r) => r.short === 1080 && r.interpolate === 2)).toBe(true);
    const m = ctx.manifest;
    expect(m.scenes[0].upscaled).toBeDefined();
    expect(m.scenes[0].smoothed).toBeUndefined();
    expect(m.ledger.filter((e) => e.stage === "interpolate")).toEqual([]);
    const hd = await probeVideo(join(ctx.dir, m.scenes[0].upscaled!.path));
    expect(hd.height).toBe(1080);
    expect(hd.fps).toBeCloseTo((await probeVideo(join(ctx.dir, "clips/clip_01.mp4"))).fps * 2, 0);
  });

  it("costs more than the upscale alone, by the extra the rates say", async () => {
    const { ctx } = await smoothRun({ fullHd: true });
    const smooth = upscaleStage.estimateCostUsd(ctx, 0);
    ctx.manifest.request.fps = undefined;
    const plain = upscaleStage.estimateCostUsd(ctx, 0);
    expect(smooth).toBeGreaterThan(plain);
  });
});

describe("a run that did not ask for smooth motion", () => {
  it("has no interpolate step, and its upscale key has no interpolate in it", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1] });
    expect(isSmoothed(ctx.manifest, 0)).toBe(false);
    expect(interpolateStage.appliesTo!(ctx.manifest, 0)).toBe(false);
    ctx.manifest.request.upscale = true;
    ctx.manifest.models.upscale = "runpod:ep-up/upscale-seedvr2@1";
    // a clip must exist for its key to be read
    await mkdir(join(ctx.dir, "clips"), { recursive: true });
    await writeFile(join(ctx.dir, "clips/clip_01.mp4"), "x");
    ctx.manifest.scenes[0].clip = { path: "clips/clip_01.mp4", duration: 3 } as never;
    const keys = Object.keys((await upscaleStage.inputsFor(ctx, 0)) as object);
    expect(keys.sort()).toEqual(["clip", "model", "short"]);
  });
});

describe("a 60 fps run whose rates are not set", () => {
  it("is refused plainly when it is priced, never charged from a guess", async () => {
    const { ctx } = await smoothRun();
    for (const key of Object.keys(RATES)) delete (ctx.prices as Record<string, unknown>)[key];
    expect(() => interpolateStage.estimateCostUsd(ctx, 0)).toThrow(/smooth motion is not set up/);
  });
});
