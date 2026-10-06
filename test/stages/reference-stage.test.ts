import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { targets, runPipeline, type RunOptions } from "../../src/pipeline.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { abs, paths } from "../../src/stages/paths.js";
import { referenceStage } from "../../src/stages/reference.js";
import { scriptStage } from "../../src/stages/script.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const STAGES = [scriptStage, referenceStage, keyframesStage];

describe("reference stage", () => {
  it("renders one square portrait of the characters and conditions every keyframe on it (RunPod runs)", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1], shots: ["cut", "cut"], seed: 5 });
    ctx.manifest.request.imageProfile = "runpod-sdxl@1";
    await runPipeline(ctx, STAGES, auto);
    const [portrait, ...keyframes] = fakes.image.submits;
    expect(portrait).toMatchObject({ width: 1024, height: 1024, seed: 5, preset: "cinematic_history" });
    expect(portrait.prompt).toContain("Character reference portrait of a red fox.");
    expect(keyframes.map((k) => k.referenceImagePath)).toEqual([abs(ctx, paths.reference), abs(ctx, paths.reference)]);
    expect(keyframes.map((k) => k.preset)).toEqual(["cinematic_history", "cinematic_history"]);
    expect(await keyframesStage.inputsFor(ctx, 0)).toMatchObject({ reference: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(keyframesStage.deps(ctx.manifest, 0)).toContainEqual({ stage: "reference", scene: 0 });
  });

  it("does not apply when the script has no characters", async () => {
    const { ctx, fakes } = await makeTestContext({
      modes: [1],
      script: () => {
        const s = fakeScript(1);
        s.styleBible.characters = "none";
        return s;
      },
    });
    ctx.manifest.request.imageProfile = "runpod-sdxl@1";
    await runPipeline(ctx, STAGES, auto);
    expect(targets(referenceStage, ctx.manifest)).toEqual([]);
    expect(fakes.image.submits.map((r) => r.referenceImagePath)).toEqual([undefined]);
  });

  it("never applies to fal runs, whose keyframe cache keys stay as before", async () => {
    const { ctx } = await makeTestContext({ modes: [1] });
    await runPipeline(ctx, [scriptStage], auto);
    expect(targets(referenceStage, ctx.manifest)).toEqual([]);
    expect(await keyframesStage.inputsFor(ctx, 0)).not.toHaveProperty("reference", expect.anything());
    expect(keyframesStage.deps(ctx.manifest, 0)).not.toContainEqual({ stage: "reference", scene: 0 });
  });

  it("uses a brand kit's portrait instead of generating one", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1] });
    ctx.manifest.request.imageProfile = "runpod-sdxl@1";
    ctx.manifest.request.referenceImage = "brand/reference.png";
    await mkdir(join(ctx.dir, "brand"), { recursive: true });
    await writeFile(join(ctx.dir, "brand/reference.png"), "portrait");
    await runPipeline(ctx, STAGES, auto);
    expect(targets(referenceStage, ctx.manifest)).toEqual([]);
    expect(fakes.image.submits.map((r) => r.referenceImagePath)).toEqual([join(ctx.dir, "brand/reference.png")]);
  });
});
