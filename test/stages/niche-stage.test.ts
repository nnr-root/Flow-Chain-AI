import { describe, expect, it } from "vitest";
import { runPipeline } from "../../src/pipeline.js";
import type { ScriptRequest } from "../../src/providers/types.js";
import { scriptStage } from "../../src/stages/script.js";
import { makeTestContext } from "../helpers/context.js";

const auto = { budgetUsd: 100, confirm: async () => true, log: () => {} };

describe("the script stage in a niche (phase 7 spec §19)", () => {
  it("asks for the script in the run's niche, and keys it on the niche only when there is one", async () => {
    const plain = await makeTestContext({ modes: [1, 1] });
    const before = (await scriptStage.inputsFor(plain.ctx)) as Record<string, unknown>;
    // a run without a niche keeps the key every earlier run has
    expect(before).not.toHaveProperty("niche");
    expect(before).not.toHaveProperty("nicheText");

    const { ctx, fakes } = await makeTestContext({ modes: [1, 1] });
    ctx.manifest.request.niche = "history";
    const seen: ScriptRequest[] = [];
    const real = fakes.llm.generateScript.bind(fakes.llm);
    fakes.llm.generateScript = async (req: ScriptRequest) => (seen.push(req), real(req));
    await runPipeline(ctx, [scriptStage], auto);
    expect(seen[0]).toMatchObject({ niche: "history" });
    expect(await scriptStage.inputsFor(ctx)).toMatchObject({ niche: "history" });
    // a niche of the user's own is the key's as well: other words, another script
    ctx.manifest.request.niche = undefined;
    ctx.manifest.request.nicheText = "Cozy cat facts";
    expect(await scriptStage.inputsFor(ctx)).toMatchObject({ nicheText: "Cozy cat facts" });
  });
});
