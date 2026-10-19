import { describe, expect, it } from "vitest";
import { FORMATS } from "../../src/formats.js";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { allowsReframe, scriptStage } from "../../src/stages/script.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const base = { topic: "The war that lasted 38 minutes", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;

describe("which types may reframe", () => {
  it("are the ones told in a place the viewer stays in: documentary, story and pov", () => {
    expect(FORMATS.filter((f) => f.reframe).map((f) => f.id).sort()).toEqual(["documentary", "pov", "story"]);
    expect(FORMATS).toHaveLength(8);
  });
});

describe("the script prompt", () => {
  it("offers reframe only when the run may use it", () => {
    expect(buildScriptPrompt({ ...base, format: "story", reframe: true })).toContain("- reframe: true on a");
    expect(buildScriptPrompt({ ...base, format: "story" })).not.toContain("reframe");
  });
});

async function runOf(opts: { format?: string; profile?: "runpod-flux3-klein@1" | "runpod-klein@1"; cutReferences?: boolean; answer: ReturnType<typeof fakeScript> }) {
  const { ctx, fakes } = await makeTestContext({ modes: "auto", sceneCount: 4, script: () => opts.answer });
  ctx.manifest.request.format = opts.format as never;
  ctx.manifest.request.imageProfile = opts.profile;
  ctx.manifest.request.cutReferences = opts.cutReferences;
  return { ctx, fakes };
}

describe("a run's permission to reframe", () => {
  it("needs a type that may, a picture profile that takes several references, and the frozen setting", async () => {
    const yes = await runOf({ format: "story", profile: "runpod-flux3-klein@1", cutReferences: true, answer: fakeScript(4) });
    expect(allowsReframe(yes.ctx.manifest)).toBe(true);
    for (const change of [{ format: "explainer" }, { profile: "runpod-klein@1" as const }, { cutReferences: false }]) {
      const no = await runOf({ format: "story", profile: "runpod-flux3-klein@1", cutReferences: true, answer: fakeScript(4), ...change });
      expect(allowsReframe(no.ctx.manifest), JSON.stringify(change)).toBe(false);
    }
  });

  it("is asked of the model only when allowed, and the question is part of the script's cache key only then", async () => {
    const off = await runOf({ format: "explainer", answer: fakeScript(4) });
    const on = await runOf({ format: "story", profile: "runpod-flux3-klein@1", cutReferences: true, answer: fakeScript(4) });
    expect(await scriptStage.inputsFor(off.ctx)).not.toHaveProperty("reframe");
    expect(await scriptStage.inputsFor(on.ctx)).toHaveProperty("reframe", true);
    await runPipeline(on.ctx, [scriptStage], auto);
    expect(on.fakes.llm.calls[0].reframe).toBe(true);
    await runPipeline(off.ctx, [scriptStage], auto);
    expect(off.fakes.llm.calls[0].reframe).toBeUndefined();
  });
});

describe("a reframe the model marked", () => {
  const marked = () => {
    const s = fakeScript(4, { shots: ["cut", "continue", "cut", "cut"] });
    s.scenes.forEach((sc) => ((sc as { reframe?: boolean }).reframe = true));
    return s;
  };

  it("is kept on a cut after the first scene, and put right everywhere else, without a paid retry", async () => {
    const { ctx, fakes } = await runOf({ format: "story", profile: "runpod-flux3-klein@1", cutReferences: true, answer: marked() });
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.script!.scenes.map((s) => s.reframe)).toEqual([false, false, true, true]);
    expect(fakes.llm.calls).toHaveLength(1);
  });

  it("is dropped from every scene when the run may not reframe", async () => {
    const { ctx } = await runOf({ format: "explainer", answer: marked() });
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.script!.scenes.every((s) => s.reframe === undefined)).toBe(true);
  });
});
