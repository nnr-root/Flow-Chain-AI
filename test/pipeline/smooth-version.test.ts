import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveManifest } from "../../src/manifest/store.js";
import { type RunOptions, runPipeline, sealInherited } from "../../src/pipeline.js";
import { STAGES } from "../../src/stages/index.js";
import { copySourceFiles, versionManifest, versionProblem } from "../../src/versions.js";
import { FakeUpscale } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";
import { tempDir } from "../helpers/media.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const RATES = { runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 };

/** A finished 60 fps English run of three scenes: a clip, a clip that carries on from it, and a still. */
async function finishedSmoothRun() {
  const made = await makeTestContext({ modes: [1, 1, 2], shots: ["cut", "continue", "cut"] });
  const restore = new FakeUpscale(join(made.dir, "_fakes"));
  made.ctx.providers = { ...made.ctx.providers, upscale: restore };
  Object.assign(made.ctx.prices, RATES);
  made.ctx.fps = 60;
  made.ctx.manifest.request.fps = 60;
  made.ctx.manifest.request.language = "en";
  made.ctx.manifest.models.upscale = "runpod:ep-up/restore-video@1";
  await runPipeline(made.ctx, STAGES, auto);
  return { ...made, restore };
}

describe("a version in another language of a 60 fps video", () => {
  it("keeps the source's frame rate and its smoothed clips, and buys no interpolation again", async () => {
    const made = await finishedSmoothRun();
    const source = made.ctx.manifest;
    const bought = made.restore.submits.length;
    const manifest = versionManifest(source, { runId: "test-version", language: "de", voiceId: source.request.voiceId, ttsModel: "fake-tts", llmModel: "fake-llm" });
    expect(manifest.request.fps).toBe(60);
    const dir = await tempDir("flowchain-version-");
    await copySourceFiles(made.ctx.dir, dir);
    const ctx = { ...made.ctx, dir, manifest };
    await sealInherited(ctx, STAGES);
    await saveManifest(dir, manifest);
    await runPipeline(ctx, STAGES, auto);
    expect(made.restore.submits.length).toBe(bought);
    expect(manifest.scenes[0].smoothed?.path).toBe("clips/clip_01.60.mp4");
    expect(manifest.scenes[2].smoothed).toBeUndefined();
    expect(manifest.ledger.some((e) => e.stage === "interpolate")).toBe(false);
  });

  it("is refused while a moving clip of the source has not been smoothed yet", async () => {
    const made = await finishedSmoothRun();
    expect(versionProblem(made.ctx.manifest, "de")).toBeNull();
    delete made.ctx.manifest.scenes[1].smoothed;
    expect(versionProblem(made.ctx.manifest, "de")).toMatch(/not made yet/);
  });
});
