import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { imageCost } from "../../src/cost.js";
import { fileSha256 } from "../../src/manifest/hash.js";
import { createManifest } from "../../src/manifest/store.js";
import type { Mode } from "../../src/manifest/schema.js";
import { countFrames } from "../../src/media/ffmpeg.js";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { clipsStage } from "../../src/stages/clips.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
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
  it("prefixes the image prompt with the style bible", () => {
    expect(imagePrompt(script, 0)).toBe("flat test pattern. a red fox. Palette: teal, orange. image 1");
  });
  it("suffixes the motion prompt with the style bible", () => {
    expect(motionPrompt(script, 0)).toBe("motion 1. Keep style consistent: flat test pattern. a red fox.");
  });
});

describe("keyframes and clips stages", () => {
  it("chains Mode 1 clips through last frames and renders Mode 2 locally", async () => {
    const { ctx, fakes } = await makeTestContext({
      modes: [1, 1, 2, 1],
      shots: ["cut", "continue", "continue", "continue"],
    });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);

    expect(fakes.image.submits).toHaveLength(3);
    expect(fakes.image.submits[0]).toMatchObject({ width: 192, height: 336, prompt: imagePrompt(ctx.manifest.script!, 0) });
    expect(fakes.video.submits.map((c) => basename(c.imagePath))).toEqual([
      "keyframe_01.png",
      "last_01.png",
      "keyframe_04.png",
    ]);
    expect(fakes.video.submits.map((c) => c.durationSec)).toEqual([5, 5, 5]);
    expect(fakes.video.submits[1].prompt).toBe(motionPrompt(ctx.manifest.script!, 1));

    expect(await countFrames(abs(ctx, paths.clip(2)))).toBe(sceneFrames(ctx.manifest, 30)[2]);
    for (const i of [0, 1, 3]) {
      const last = ctx.manifest.scenes[i].lastFrame!;
      expect(last.sha256).toBe(await fileSha256(abs(ctx, last.path)));
    }
    expect(ctx.manifest.scenes[2].lastFrame).toBeUndefined();

    const paid = (stage: string) => ctx.manifest.ledger.filter((e) => e.stage === stage).map((e) => e.usd);
    expect(paid("keyframes")).toEqual([0, 2, 3].map(() => imageCost(ctx.prices, ctx.keyframeSize)));
    expect(paid("clips")).toEqual([0.25, 0.25, 0.25]);
  });
});
