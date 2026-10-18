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

  it("records nothing for a model that does not say which prompt it writes with", async () => {
    const { ctx } = await makeTestContext({ modes: "auto", sceneCount: 2 });
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.scriptPromptVersion).toBeUndefined();
  });

  it("keeps the stage's input hash the same whatever prompt version the model says, before and after the run", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", sceneCount: 2 });
    const unset = await scriptStage.inputsFor(ctx);
    fakes.llm.promptVersion = "test-1";
    expect(await scriptStage.inputsFor(ctx)).toEqual(unset);
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.scriptPromptVersion).toBe("test-1");
    expect(await scriptStage.inputsFor(ctx)).toEqual(unset);
  });
});
