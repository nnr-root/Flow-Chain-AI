import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { type RunOptions, runPipeline } from "../../src/pipeline.js";
import { buildScriptPrompt, inspectPrompt } from "../../src/providers/gemini.js";
import type { InspectRequest } from "../../src/providers/types.js";
import { STAGES } from "../../src/stages/index.js";
import { inspectCost } from "../../src/stages/inspect.js";
import { referenceApplies } from "../../src/stages/reference.js";
import { referenceStage } from "../../src/stages/reference.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 8 spec §9: a falcon with two heads, a third wing, and hands.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("a look at every picture and clip before what follows from it is bought", () => {
  it("makes a malformed picture again with another seed, twice at most, and pays for each look", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [2, 2], seed: 100 });
    const seen: InspectRequest[] = [];
    // scene 1's picture is malformed every time; scene 2's is fine
    fakes.llm.inspect = async (req) => (seen.push(req), req.expected.includes("image 1") ? { ok: false, problems: ["two heads"] } : { ok: true, problems: [] });
    await runPipeline(ctx, STAGES, auto);
    const prompts = fakes.image.submits.filter((r) => r.prompt.includes("image 1"));
    // the first, then two remakes, each with a new seed; the last is used whatever it is
    expect(prompts).toHaveLength(3);
    expect(new Set(prompts.map((r) => r.seed)).size).toBe(3);
    expect(fakes.image.submits.filter((r) => r.prompt.includes("image 2"))).toHaveLength(1);
    // the third is not looked at: nothing more would be done about it
    expect(seen.filter((r) => r.expected.includes("image 1"))).toHaveLength(2);
    expect(seen[0].expected).toContain("a red fox");
    const looks = ctx.manifest.ledger.filter((e) => e.stage === "keyframes" && e.usd === inspectCost(ctx.prices, 1));
    expect(looks).toHaveLength(3);
    expect(ctx.manifest.scenes[0].remade?.keyframes?.count).toBe(2);
  });

  it("makes a malformed clip again once, looking at three of its frames", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1], shots: ["cut", "cut"] });
    let looks = 0;
    fakes.llm.inspect = async (req) => (req.images.length === 3 && looks++ === 0 ? { ok: false, problems: ["a third wing"] } : { ok: true, problems: [] });
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.video.submits.filter((r) => r.prompt.startsWith("motion 1"))).toHaveLength(2);
    expect(fakes.video.submits.filter((r) => r.prompt.startsWith("motion 2"))).toHaveLength(1);
  });

  it("uses the picture as it is when the look cannot be had, and looks at nothing without a checker", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [2] });
    fakes.llm.inspect = async () => {
      throw new Error("model away");
    };
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.submits).toHaveLength(1);
    expect(ctx.manifest.scenes[0].keyframe).toBeDefined();
    const plain = await makeTestContext({ modes: [2] });
    await runPipeline(plain.ctx, STAGES, auto);
    expect(plain.fakes.image.submits).toHaveLength(1);
  });

  it("carries a stopped remake on from where it was, buying no picture twice", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [2], seed: 5 });
    let n = 0;
    fakes.llm.inspect = async () => ({ ok: n++ > 0, problems: n === 1 ? ["extra legs"] : [] });
    fakes.image.failWait = (r) => r.seed !== 5; // the remake's wait fails: the run stops with its request kept
    await expect(runPipeline(ctx, STAGES, auto)).rejects.toThrow();
    expect(fakes.image.submits).toHaveLength(2);
    fakes.image.failWait = undefined;
    await runPipeline(ctx, STAGES, auto);
    // the remake's request was polled again, not bought again, and the first picture was not bought again either
    expect(fakes.image.submits).toHaveLength(2);
  });

  it("asks only about faults a viewer sees at a glance, never about taste", () => {
    const p = inspectPrompt({ images: ["a"], expected: "a peregrine falcon gliding" });
    expect(p).toContain("It should show: a peregrine falcon gliding");
    expect(p).toContain("too many or too few heads, legs, arms, wings, tails or eyes");
    expect(p).toContain("human hands, arms or a human face on an animal");
    expect(p).toContain("Style, colour, framing, lighting and small details are never faults");
    expect(inspectCost(Prices.parse({}), 3)).toBeLessThan(0.001);
  });
});

describe("a character that is not a person", () => {
  it("is never drawn from a portrait when it is a real kind of animal", async () => {
    const { ctx } = await makeTestContext({ modes: [2, 2], characters: "an adult peregrine falcon" });
    ctx.manifest.request.imageProfile = "runpod-klein@1";
    ctx.manifest.script = fakeScript(2, { characterKind: "animal" });
    expect(referenceApplies(ctx.manifest, 0)).toBe(false);
    ctx.manifest.script = fakeScript(2, { characterKind: "people" });
    expect(referenceApplies(ctx.manifest, 0)).toBe(true);
  });

  it("is asked for whole and in its own shape when it is made up, with nothing of a person's pose or clothes", async () => {
    const { ctx } = await makeTestContext({ modes: [2, 2] });
    ctx.manifest.request.imageProfile = "runpod-klein@1";
    ctx.manifest.script = fakeScript(2, { characterKind: "other" });
    const { prompt } = (await referenceStage.inputsFor(ctx, 0)) as { prompt: string };
    expect(prompt).toContain("the whole figure in a calm natural pose");
    expect(prompt).not.toMatch(/arms|hands|waist-up|clothes/);
    // a person's portrait is as it was
    ctx.manifest.script = fakeScript(2, { characterKind: "people" });
    expect(((await referenceStage.inputsFor(ctx, 0)) as { prompt: string }).prompt).toContain("arms relaxed at the sides");
  });

  it("is told to the script's model: what kind it is, how an animal is posed and moves, and to tell one story", () => {
    const p = buildScriptPrompt({ topic: "How a peregrine falcon dives", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" });
    expect(p).toContain('styleBible.characterKind: "people" if the recurring characters are people, "animal"');
    expect(p).toContain("An animal is drawn whole, one of it, in a simple natural pose seen from the side or at three-quarters");
    expect(p).toContain("Never folded, tucked, curled or twisted, never from straight above or below");
    expect(p).toContain("wings do not beat and legs do not run");
    expect(p).toContain("It is one spoken piece, not a list of facts read out");
    expect(p).toContain("If the first line asks a question, the last line answers it in plain words");
  });
});
