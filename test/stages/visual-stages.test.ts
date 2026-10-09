import { existsSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { imageCost } from "../../src/cost.js";
import { rm } from "node:fs/promises";
import { createManifest } from "../../src/manifest/store.js";
import { MAX_SEED, type Mode } from "../../src/manifest/schema.js";
import { countFrames } from "../../src/media/ffmpeg.js";
import { computeHash, runPipeline, type RunOptions } from "../../src/pipeline.js";
import { PRESETS } from "../../src/presets.js";
import { clipsStage } from "../../src/stages/clips.js";
import { keyframeSeed, keyframesStage } from "../../src/stages/keyframes.js";
import { abs, paths } from "../../src/stages/paths.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { imagePrompt, motionPrompt, needsKeyframe, sceneFrames } from "../../src/stages/visual.js";
import { fakeScript, type Shot } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const models = { llm: "l", tts: "t", image: "i", video: "v" };

function manifestWith(modes: Mode[], shots?: Shot[]) {
  const m = createManifest("r", { topic: "t", aspect: "9:16", sceneCount: modes.length, modes, voiceId: "v" }, models);
  if (shots) m.script = fakeScript(modes.length, { shots });
  return m;
}

describe("needsKeyframe", () => {
  it("starts a fresh chain at scene 1, Mode 2 scenes, scenes after Mode 2, and cuts", () => {
    const m = manifestWith([1, 1, 2, 1, 1], ["cut", "continue", "continue", "continue", "cut"]);
    expect(m.scenes.map((s) => needsKeyframe(m, s.idx))).toEqual([true, false, true, true, true]);
  });

  it("works before the script exists", () => {
    const m = manifestWith([1, 1, 2, 1]);
    expect(m.scenes.map((s) => needsKeyframe(m, s.idx))).toEqual([true, false, true, true]);
  });
});

describe("prompts", () => {
  const script = fakeScript(1);
  it("keeps the Phase 1 wording without a preset (runs scripted before 2.2)", () => {
    expect(imagePrompt(script, 0, null)).toBe("flat test pattern. a red fox. Palette: teal, orange. image 1");
    expect(motionPrompt(script, 0, null)).toBe("motion 1. Keep style consistent: flat test pattern. a red fox.");
  });
  it("tells a scene without the character nothing about them, and reads a script that does not say as before", () => {
    const two = fakeScript(2, { shown: [true, false] });
    expect(imagePrompt(two, 1, null)).toBe("flat test pattern. Palette: teal, orange. image 2");
    expect(motionPrompt(two, 1, null)).toBe("motion 2. Keep style consistent: flat test pattern.");
    expect(imagePrompt(two, 1, PRESETS.cyberpunk)).not.toContain("a red fox");
    const old = fakeScript(1);
    delete (old.scenes[0] as { showsCharacter?: boolean }).showsCharacter;
    expect(imagePrompt(old, 0, null)).toBe("flat test pattern. a red fox. Palette: teal, orange. image 1");
  });
  it("wraps the image prompt in the preset's prefix and suffix", () => {
    const p = PRESETS.cyberpunk;
    expect(imagePrompt(script, 0, p)).toBe(
      `${p.imagePrefix}. a red fox. Palette: teal, orange. image 1. ${p.imageSuffix}`,
    );
  });
  it("adds the preset's motion keywords to the motion prompt", () => {
    const p = PRESETS.anime;
    expect(motionPrompt(script, 0, p)).toBe(
      `motion 1. ${p.motionKeywords}. Keep style consistent: flat test pattern. a red fox.`,
    );
  });
});

describe("shared keyframe seed", () => {
  it("sends the run's seed with every keyframe and changes it for a rerolled scene", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1], shots: ["cut", "cut"], seed: 41 });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage], auto);
    expect(fakes.image.submits.map((r) => r.seed)).toEqual([41, 41]);
    ctx.manifest.scenes[1].nonces.keyframes = 1; // what `reroll --scene 2 --stage keyframes` does
    expect(keyframeSeed(ctx.manifest, 1)).toBe(42);
    expect(keyframeSeed(ctx.manifest, 0)).toBe(41);
  });

  it("keys keyframes on the seed only when the run has one", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1] });
    await runPipeline(ctx, [scriptStage], auto);
    expect(await keyframesStage.inputsFor(ctx, 0)).not.toHaveProperty("seed", expect.anything());
    ctx.manifest.request.seed = 7;
    expect(await keyframesStage.inputsFor(ctx, 0)).toMatchObject({ seed: 7 });
    ctx.manifest.request.seed = MAX_SEED;
    ctx.manifest.scenes[0].nonces.keyframes = 2;
    expect(keyframeSeed(ctx.manifest, 0)).toBe(1); // wraps around 2^31
  });
});

describe("keyframes and clips stages", () => {
  it("chains Mode 1 clips through seam frames and buys no clip for a Mode 2 scene", async () => {
    const { ctx, fakes } = await makeTestContext({
      modes: [1, 1, 2, 1],
      shots: ["cut", "continue", "continue", "continue"],
    });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);

    expect(fakes.image.submits).toHaveLength(3);
    expect(fakes.image.submits[0]).toMatchObject({ width: 192, height: 336, prompt: imagePrompt(ctx.manifest.script!, 0, PRESETS.cinematic_history) });
    expect(fakes.video.submits.map((c) => basename(c.imagePath))).toEqual([
      "keyframe_01.png",
      "seam_01.png",
      "keyframe_04.png",
    ]);
    expect(fakes.video.submits.map((c) => c.durationSec)).toEqual([5, 5, 5]);
    expect(fakes.video.submits[1].prompt).toBe(motionPrompt(ctx.manifest.script!, 1, PRESETS.cinematic_history));

    expect(ctx.manifest.scenes[2].clip).toBeUndefined(); // Mode 2 is animated from its keyframe at render time
    expect(existsSync(abs(ctx, paths.clip(2)))).toBe(false);

    const paid = (stage: string) => ctx.manifest.ledger.filter((e) => e.stage === stage).map((e) => e.usd);
    expect(paid("keyframes")).toEqual([0, 2, 3].map(() => imageCost(ctx.prices, ctx.keyframeSize)));
    expect(paid("clips")).toEqual([0.25, 0.25, 0.25]);
  });

  it("keys a continuing clip on the previous clip and its frame count, never on the seam file", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1], shots: ["cut", "continue"] });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    const hash = await computeHash(ctx, clipsStage, 1);
    expect(hash).toBe(ctx.manifest.scenes[1].stages.clips?.inputHash);

    await rm(abs(ctx, paths.seam(0)));
    expect(await computeHash(ctx, clipsStage, 1)).toBe(hash);

    ctx.manifest.scenes[0].audio!.duration += 1 / 30; // frames_0 grows by one, so the seam frame moves
    expect(await computeHash(ctx, clipsStage, 1)).not.toBe(hash);

    expect(clipsStage.deps(ctx.manifest, 1)).toEqual(
      expect.arrayContaining([
        { stage: "clips", scene: 0 },
        { stage: "silence", scene: 0 },
        { stage: "silence", scene: 1 },
      ]),
    );
  });
});

describe("wait deadline", () => {
  it("passes the provider's own waitMs, not the fal default, as the job timeout of keyframes and clips", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1], shots: ["cut"] });
    fakes.image.waitMs = 777_000;
    fakes.video.waitMs = 888_000;
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    expect(fakes.image.waitTimeouts).toEqual([777_000]);
    expect(fakes.video.waitTimeouts).toEqual([888_000]);
  });

  it("gives a submit the provider's own allowance: a slow upload fails within submitMs, and passes with enough of it", async () => {
    const tight = await makeTestContext({ modes: [1], shots: ["cut"] });
    tight.fakes.image.submitDelayMs = 150;
    tight.fakes.image.submitMs = 20;
    await expect(runPipeline(tight.ctx, [scriptStage, ttsStage, silenceStage, keyframesStage], auto)).rejects.toThrow(
      "submit timed out after 20 ms",
    );
    expect(tight.ctx.manifest.scenes[0].jobs.keyframes).toBeUndefined(); // nothing was recorded as bought

    const roomy = await makeTestContext({ modes: [1], shots: ["cut"] });
    roomy.fakes.image.submitDelayMs = 150;
    roomy.fakes.video.submitDelayMs = 150;
    roomy.fakes.image.submitMs = 5_000;
    roomy.fakes.video.submitMs = 5_000;
    await runPipeline(roomy.ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    expect(roomy.ctx.manifest.scenes[0].stages.clips?.status).toBe("done");
  });
});

describe("clip lengths from the run's video profile", () => {
  it("buys a 5 s clip for 5.5 s of narration on kling-v2, a 10 s one on kling-v1 (runs made before 2.3)", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1], shots: ["cut", "cut"] });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage], auto);
    ctx.manifest.scenes[0].audio!.duration = 5.5;
    expect(await clipsStage.inputsFor(ctx, 0)).toMatchObject({ requestedSec: 10 });
    expect(clipsStage.estimateCostUsd(ctx, 0)).toBe(0.5);
    ctx.manifest.request.videoProfile = "kling-v2";
    expect(await clipsStage.inputsFor(ctx, 0)).toMatchObject({ requestedSec: 5 });
    expect(clipsStage.estimateCostUsd(ctx, 0)).toBe(0.25);
  });
});
