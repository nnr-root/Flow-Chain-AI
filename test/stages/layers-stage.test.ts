import { describe, expect, it } from "vitest";
import { runPipeline } from "../../src/pipeline.js";
import type { ScriptRequest } from "../../src/providers/types.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { scriptStage } from "../../src/stages/script.js";
import { makeTestContext } from "../helpers/context.js";

const auto = { budgetUsd: 100, confirm: async () => true, log: () => {} };

describe("the script stage with a type, an edit and an audience (phase 8 spec)", () => {
  it("asks for the script with them, and keys it on each only when the run has it", async () => {
    const plain = await makeTestContext({ modes: [1, 1] });
    const before = (await scriptStage.inputsFor(plain.ctx)) as Record<string, unknown>;
    // a run without them keeps the key every earlier run has
    for (const field of ["format", "edit", "localize"]) expect(before).not.toHaveProperty(field);

    const { ctx, fakes } = await makeTestContext({ modes: [1, 1] });
    Object.assign(ctx.manifest.request, { format: "countdown", edit: "calm", language: "tr", localize: true });
    const seen: ScriptRequest[] = [];
    const real = fakes.llm.generateScript.bind(fakes.llm);
    fakes.llm.generateScript = async (req: ScriptRequest) => (seen.push(req), real(req));
    await runPipeline(ctx, [scriptStage], auto);
    expect(seen[0]).toMatchObject({ format: "countdown", edit: "calm", localize: true });
    expect(await scriptStage.inputsFor(ctx)).toMatchObject({ format: "countdown", edit: "calm", localize: true });
    // a run frozen as not made for its viewers is keyed as one that never was
    ctx.manifest.request.localize = false;
    expect(await scriptStage.inputsFor(ctx)).not.toHaveProperty("localize");
  });

  it("asks for every picture with the edit's words, so a picture bought without them is bought again", async () => {
    const { ctx } = await makeTestContext({ modes: [2, 2] });
    await runPipeline(ctx, [scriptStage], auto);
    const plain = (await keyframesStage.inputsFor(ctx, 0)) as { prompt: string };
    ctx.manifest.request.edit = "cinematic";
    const edited = (await keyframesStage.inputsFor(ctx, 0)) as { prompt: string };
    expect(edited.prompt).toContain("Dramatic directional light");
    expect(plain.prompt).not.toContain("Dramatic directional light");
  });
});
