import { describe, expect, it } from "vitest";
import { loadEnv, Prices } from "../../src/config.js";
import { loadManifest } from "../../src/manifest/store.js";
import { createProviders } from "../../src/providers/factory.js";
import { CLIPS_UNAVAILABLE, NO_CLIPS_MODEL } from "../../src/providers/model-id.js";
import { newRunProviders } from "../../src/providers/new-run.js";
import { runPipeline } from "../../src/pipeline.js";
import { STAGES } from "../../src/stages/index.js";
import { timedScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto = { budgetUsd: 100, confirm: async () => true };

/**
 * A studio with no clip engine (LTX off, or not set up; Wan removed, phase 15 spec §13.10) still makes a video of pictures
 * only: `newRunProviders` freezes it with `NO_CLIPS_MODEL`, and no LTX rate is ever read for it.
 */
async function picturesRun() {
  const env = loadEnv({ GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "ep-k", R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s" });
  const prices = Prices.parse({});
  const frozen = newRunProviders(env, prices, true);
  const timing = { targetSec: 10, sceneSec: { min: 3, max: 5 } };
  const made = await makeTestContext({ modes: "auto", timing, script: () => timedScript([13, 13]) });
  // what the studio's "Pictures only" becomes: every scene pinned to a still, for the scenes assumed
  made.ctx.manifest.request.modeOverrides = made.ctx.manifest.scenes.map(() => 2 as const);
  // (and its scenes start as what they were pinned to, as `createManifest` starts them: no clip is priced before the script)
  for (const s of made.ctx.manifest.scenes) s.mode = 2;
  made.ctx.manifest.request.videoProfile = frozen.videoProfile;
  made.ctx.manifest.models.video = frozen.video;
  made.ctx.prices = prices;
  // the run's own clip provider, as `createProviders` builds it for this run; the rest stay the stand-ins
  made.ctx.providers = { ...made.ctx.providers, video: createProviders(env, made.ctx.manifest.models, prices).video };
  return made;
}

describe("a video of pictures only, made where no clip engine is set up", () => {
  it("is made to the end without a clip engine or any of its rates, buying no clip", async () => {
    const { ctx, fakes } = await picturesRun();
    expect(ctx.manifest.models.video).toBe(NO_CLIPS_MODEL);
    await runPipeline(ctx, STAGES, auto);
    const done = await loadManifest(ctx.dir);
    expect(done.scenes.map((s) => s.mode)).toEqual([2, 2]);
    expect(fakes.video.submits).toHaveLength(0);
    expect(fakes.image.submits).toHaveLength(2);
    expect(done.final).toBeDefined();
  }, 180_000);

  it("refuses a clip asked of it later in one plain sentence, before anything is bought", async () => {
    const { ctx } = await picturesRun();
    await expect(ctx.providers.video.prepare({ imagePath: "x.png", prompt: "p", durationSec: 121 / 24, seed: 1 })).rejects.toThrow(CLIPS_UNAVAILABLE);
    await expect(ctx.providers.video.submit({ input: {} }, { signal: new AbortController().signal })).rejects.toThrow(CLIPS_UNAVAILABLE);
  });
});
