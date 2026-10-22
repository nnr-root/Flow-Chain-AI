import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type RunOptions, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { STAGES } from "../../src/stages/index.js";
import { sceneStagesShown } from "../../src/studio/status.js";
import { STAGE_LABELS } from "../../web/lib/labels.js";
import { FakeUpscale } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

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

describe("rerolling a smoothed clip", () => {
  it("asks again for that scene's interpolation only, and refuses a scene that has none", async () => {
    const { ctx, restore } = await smoothRun();
    await runPipeline(ctx, STAGES, auto);
    const asked = restore.submits.length;
    expect(() => bumpNonce(ctx.manifest, 3, "interpolate")).toThrow(/no smoothed clip/);
    bumpNonce(ctx.manifest, 1, "interpolate");
    await runPipeline(ctx, STAGES, auto);
    expect(restore.submits.length).toBe(asked + 1);
  });

  it("is refused on a run that did not ask for smooth motion, and in full HD (the upscale job does it)", async () => {
    const plain = await makeTestContext({ modes: [1] });
    expect(() => bumpNonce(plain.ctx.manifest, 1, "interpolate")).toThrow(/no smoothed clip/);
    const hd = await smoothRun({ fullHd: true });
    expect(() => bumpNonce(hd.ctx.manifest, 1, "interpolate")).toThrow(/no smoothed clip/);
  });
});

describe("the studio's list of a scene's steps", () => {
  it("shows the smooth-motion step only on a moving scene of a 60 fps run without full HD", async () => {
    const { ctx } = await smoothRun();
    expect(sceneStagesShown(ctx.manifest, 0)).toContain("interpolate");
    expect(sceneStagesShown(ctx.manifest, 2)).not.toContain("interpolate");
    ctx.manifest.request.upscale = true;
    expect(sceneStagesShown(ctx.manifest, 0)).not.toContain("interpolate");
    expect(sceneStagesShown(ctx.manifest, 0)).toContain("upscale");
    expect(STAGE_LABELS.interpolate).toBe("Smooth motion");
  });
});
