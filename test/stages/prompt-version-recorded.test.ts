import { describe, expect, it } from "vitest";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { scriptStage } from "../../src/stages/script.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("the script stage", () => {
  it("records which prompt wrote the script, when the model says so", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", sceneCount: 2 });
    fakes.llm.promptVersion = "test-1";
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.scriptPromptVersion).toBe("test-1");
  });

  it("records nothing for a model that does not say, and keeps its input hash the same either way", async () => {
    const { ctx } = await makeTestContext({ modes: "auto", sceneCount: 2 });
    const before = await scriptStage.inputsFor(ctx);
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.scriptPromptVersion).toBeUndefined();
    expect(await scriptStage.inputsFor(ctx)).toEqual(before);
  });
});
