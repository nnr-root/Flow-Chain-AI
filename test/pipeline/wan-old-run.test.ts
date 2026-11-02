import { afterEach, describe, expect, it, vi } from "vitest";
import { Prices } from "../../src/config.js";
import { loadManifest, saveManifest } from "../../src/manifest/store.js";
import { createProviders } from "../../src/providers/factory.js";
import { NonRetryableError } from "../../src/providers/retry.js";
import { planRun, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { applyRenderOptions, assertRenderOnly, noPaidProviders, withLook } from "../../src/rerender.js";
import { STAGES } from "../../src/stages/index.js";
import { RETIRED_CLIP_ENGINE, VIDEO_PROFILES } from "../../src/video-profiles.js";
import { makeTestContext } from "../helpers/context.js";

const WAN_MODEL = "runpod:ep-c/clip-wan22-480p@1";
const env = {
  GEMINI_API_KEY: "g", GEMINI_MODEL: "m", ELEVENLABS_MODEL: "eleven_multilingual_v2", FLOWCHAIN_BUDGET_USD: 3, FLOWCHAIN_VOICE: "narrator-m",
  FLOWCHAIN_CUT_REFERENCES: "off" as const, FLOWCHAIN_SMOOTH_MOTION: "off" as const, FLOWCHAIN_TREND_IDEAS: "off" as const, FLOWCHAIN_SCENE_SOUND: "off" as const,
  RUNS_DIR: "./runs", RUNPOD_API_KEY: "rk", R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s",
};

afterEach(() => vi.restoreAllMocks());

/**
 * A run finished on Wan before it was removed (phase 15 spec §13.10): its clip model and profile are Wan's and its clips are
 * on disk. It is made here as it was made then, with Wan's profile priced as it used to be for the making only.
 */
async function finishedWanRun(modes: [1, 1] | "auto") {
  const made = await makeTestContext({ modes, shots: ["cut", "continue"], ...(modes === "auto" ? { sceneCount: 2, actionLevels: ["high", "high"] as const } : {}) });
  made.ctx.manifest.request.videoProfile = "wan22-480p@1";
  made.ctx.manifest.models.video = WAN_MODEL;
  const wan = VIDEO_PROFILES["wan22-480p@1"];
  const cost = vi.spyOn(wan, "costUsd").mockImplementation((_p, clipSec) => Math.round(clipSec * 16) * 0.0003);
  const overhead = vi.spyOn(wan, "runOverheadUsd").mockImplementation(() => 0.03);
  await runPipeline(made.ctx, STAGES, { budgetUsd: 100, confirm: async () => true });
  cost.mockRestore();
  overhead.mockRestore();
  await saveManifest(made.ctx.dir, made.ctx.manifest);
  return made;
}

describe("a run finished on Wan, after Wan was removed", () => {
  for (const modes of [[1, 1] as [1, 1], "auto" as const]) {
    it(`loads, plans nothing paid and re-renders for free with a new look (${modes === "auto" ? "auto modes" : "modes 1,1"})`, async () => {
      const { ctx, fakes } = await finishedWanRun(modes);
      const loaded = await loadManifest(ctx.dir);
      expect(loaded.models.video).toBe(WAN_MODEL);
      expect(loaded.request.videoProfile).toBe("wan22-480p@1");
      expect(loaded.scenes.map((s) => s.mode)).toEqual([1, 1]);
      expect(loaded.scenes.every((s) => s.clip !== undefined)).toBe(true);
      const bought = fakes.video.submits.length;
      expect(bought).toBe(2);

      const free = { ...ctx, manifest: loaded, providers: noPaidProviders() };
      // as it stands: nothing at all is due, the modes stage included (its clip lengths are the ones it was planned on)
      expect((await planRun(free, STAGES)).items).toEqual([]);
      // with another look: only the free steps, at no cost, so `rerender` accepts it
      const look = { captionStyle: "mrbeast" };
      const plan = await planRun({ ...free, manifest: withLook(loaded, look) }, STAGES);
      expect(plan.items.length).toBeGreaterThan(0);
      expect(plan.items.every((i) => i.costUsd === 0)).toBe(true);
      expect(plan.totalUsd).toBe(0);
      expect(() => assertRenderOnly(plan, loaded.runId)).not.toThrow();
      applyRenderOptions(loaded, look);
      await runPipeline(free, STAGES, { budgetUsd: 0, confirm: async () => false });
      expect((await loadManifest(ctx.dir)).final).toBeDefined();
      expect(fakes.video.submits).toHaveLength(bought);
    }, 180_000);
  }

  it("refuses, with the retired text that names no model, a clip asked for again, before anything is bought", async () => {
    const { ctx, fakes } = await finishedWanRun([1, 1]);
    const loaded = await loadManifest(ctx.dir);
    bumpNonce(loaded, 2, "clips");
    const real = { ...ctx, manifest: loaded, providers: createProviders(env, loaded.models, Prices.parse({})) };
    await expect(planRun(real, STAGES)).rejects.toThrow(RETIRED_CLIP_ENGINE);
    await expect(runPipeline(real, STAGES, { budgetUsd: 100, confirm: async () => true })).rejects.toThrow(RETIRED_CLIP_ENGINE);
    // and its clip provider itself refuses, should anything reach it
    await expect(real.providers.video.prepare({ imagePath: "x.png", prompt: "p", durationSec: 81 / 16 })).rejects.toBeInstanceOf(NonRetryableError);
    expect(fakes.video.submits).toHaveLength(2);
    expect((await loadManifest(ctx.dir)).ledger.filter((e) => e.stage === "clips")).toHaveLength(2);
  }, 180_000);
});
