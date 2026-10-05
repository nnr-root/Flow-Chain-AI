import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { planRun, type Plan, runPipeline, type RunOptions } from "../../src/pipeline.js";
import { PRESETS } from "../../src/presets.js";
import { clipsStage } from "../../src/stages/clips.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { modesStage } from "../../src/stages/modes.js";
import { renderStage } from "../../src/stages/render.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { makeTestContext } from "../helpers/context.js";

const STAGES = [scriptStage, ttsStage, silenceStage, modesStage, keyframesStage, clipsStage];
const AUDIO = [scriptStage, ttsStage, silenceStage, modesStage];

function capture() {
  const plans: Record<string, Plan> = {};
  const opts: RunOptions = { budgetUsd: 100, confirm: async () => true, onPlan: (plan, label) => (plans[label] = plan) };
  const steps = (label: string, stage: string) =>
    plans[label].items.filter((i) => i.stage === stage).map((i) => (i.scene ?? -1) + 1);
  return { opts, steps };
}

describe("modes stage", () => {
  it("auto: high and medium become Mode 1, low becomes Mode 2, each with its reason", async () => {
    const { ctx } = await makeTestContext({ modes: "auto", actionLevels: ["high", "medium", "low"] });
    await runPipeline(ctx, AUDIO, capture().opts);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([1, 1, 2]);
    expect(ctx.manifest.scenes.map((s) => s.modeReason)).toEqual([
      "auto: high action",
      "auto: medium action",
      "auto: low action",
    ]);
  });

  it("auto: a tight budget sends the medium scene with the largest saving to Mode 2", async () => {
    // all Mode 1 ≈ $0.80; dropping scene 3 saves one clip and adds one keyframe (scene 2 would add two)
    const { ctx } = await makeTestContext({ modes: "auto", budgetUsd: 0.6, actionLevels: ["high", "medium", "medium"] });
    await runPipeline(ctx, AUDIO, capture().opts);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([1, 1, 2]);
    expect(ctx.manifest.scenes[2].modeReason).toBe("auto: medium action → Mode 2 to fit $0.60");
  });

  it("explicit modes are copied as given", async () => {
    const { ctx } = await makeTestContext({ modes: [2, 1], actionLevels: ["high", "low"] });
    await runPipeline(ctx, AUDIO, capture().opts);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([2, 1]);
    expect(ctx.manifest.scenes.map((s) => s.modeReason)).toEqual(["explicit", "explicit"]);
  });

  it("only auto runs list it as a dependency of keyframes, clips and render", async () => {
    const { ctx: explicit } = await makeTestContext({ modes: [1, 1] });
    const { ctx: auto } = await makeTestContext({ modes: "auto" });
    for (const [stage, scene] of [[keyframesStage, 0], [clipsStage, 1], [renderStage, undefined]] as const) {
      expect(stage.deps(explicit.manifest, scene)).not.toContainEqual({ stage: "modes" });
      expect(stage.deps(auto.manifest, scene)).toContainEqual({ stage: "modes" });
    }
  });

  it("the first checkpoint assumes Mode 1 everywhere; the media checkpoint prices the resolved modes", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", actionLevels: ["high", "medium", "low"] });
    const { opts, steps } = capture();
    await runPipeline(ctx, STAGES, opts);
    expect(steps("Plan", "clips")).toEqual([1, 2, 3]);
    expect(steps("Media plan", "keyframes")).toEqual([1, 3]); // scene 2 continues from scene 1's seam
    expect(steps("Media plan", "clips")).toEqual([1, 2]);
    expect(fakes.video.submits).toHaveLength(2);
  });

  it("wraps the prompts sent to the image and video providers in the preset", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1], style: "cyberpunk" });
    await runPipeline(ctx, STAGES, capture().opts);
    const p = PRESETS.cyberpunk;
    expect(fakes.image.submits[0].prompt).toBe(
      `${p.imagePrefix}. a red fox. Palette: teal, orange. image 1. ${p.imageSuffix}`,
    );
    for (const call of fakes.video.submits) {
      expect(call.prompt).toContain(`. ${p.motionKeywords}. Keep style consistent: ${p.artStyle}. a red fox.`);
    }
  });

  it("a finished auto run does not re-plan when the price table changes afterwards", async () => {
    const { ctx } = await makeTestContext({ modes: "auto", actionLevels: ["high", "medium", "low"] });
    await runPipeline(ctx, STAGES, capture().opts);
    ctx.prices = Prices.parse({ ttsPer1kChars: 0.6 });
    expect((await planRun(ctx, STAGES)).items).toEqual([]);
  });

  it("auto: once media is bought, a re-run keeps every scene's mode even if the budget shrank", async () => {
    const { ctx, logs } = await makeTestContext({ modes: "auto", budgetUsd: 3, actionLevels: ["high", "medium", "low"] });
    await runPipeline(ctx, STAGES, capture().opts);
    const reasons = ctx.manifest.scenes.map((s) => s.modeReason);
    ctx.manifest.request.modeBudgetUsd = 0.01;
    await runPipeline(ctx, [modesStage], capture().opts);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([1, 1, 2]);
    expect(ctx.manifest.scenes.map((s) => s.modeReason)).toEqual(reasons);
    expect(logs).toContain("modes kept at 1,1,2: media was already bought for them");
  });

  it("control: with no media bought yet, the same shrunken budget does re-plan", async () => {
    const { ctx } = await makeTestContext({ modes: "auto", budgetUsd: 3, actionLevels: ["high", "medium", "low"] });
    await runPipeline(ctx, AUDIO, capture().opts);
    ctx.manifest.request.modeBudgetUsd = 0.01;
    await runPipeline(ctx, [modesStage], capture().opts);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([1, 2, 2]);
  });

  it("logs how many scenes had no actionLevel and were treated as high", async () => {
    const { ctx, logs } = await makeTestContext({ modes: "auto" });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage], capture().opts);
    for (const sc of ctx.manifest.script!.scenes) delete (sc as { actionLevel?: unknown }).actionLevel;
    await runPipeline(ctx, [modesStage], capture().opts);
    expect(logs).toContain("modes: 3 scene(s) have no actionLevel; treated as high");
  });
});
