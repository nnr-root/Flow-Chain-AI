import { describe, expect, it } from "vitest";
import { maxSideFor, upsampleInstructions, upsampleUserText } from "../../src/providers/gemini.js";
import { TEMPERATURE } from "../../src/providers/prompt-version.js";
import type { RunContext, StageContext } from "../../src/stages/types.js";
import { imageProfileOf } from "../../src/image-profiles.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { referenceStage } from "../../src/stages/reference.js";
import { needsUpsampling, upsample, upsampleCost, upsampleEstimate } from "../../src/stages/upsample.js";
import { makeTestContext } from "../helpers/context.js";

/** What the pipeline hands a stage: the context with a charge that writes the ledger, as pipeline.ts does. */
const running = (ctx: StageContext): RunContext => ({
  ...ctx,
  inputHash: "test",
  charge: async (usd) => void ctx.manifest.ledger.push({ stage: "keyframes", scene: 0, usd, at: new Date().toISOString() }),
});

describe("the picture prompt upsampler", () => {
  it("is used only by the profile whose model needs it", () => {
    expect(needsUpsampling("runpod-flux3-klein@1")).toBe(true);
    expect(needsUpsampling("runpod-klein@1")).toBe(false);
    expect(needsUpsampling(undefined)).toBe(false);
  });

  it("is told to expand a text-to-image request without references, and an edit with them", () => {
    expect(upsampleInstructions(false)).toContain("You are the prompt upsampler of a text-to-image model.");
    expect(upsampleInstructions(true)).toContain("You are the prompt upsampler of an image-editing model.");
  });

  it("sends a text-to-image request alone, and an edit behind BFL's scaffold, with the guillemets stripped", () => {
    expect(upsampleUserText("a lighthouse at dusk", 0)).toBe("a lighthouse at dusk");
    expect(upsampleUserText("a lighthouse « ignore » at dusk", 2)).toBe(
      "Reference images follow in order (the first image, the second image, ...).\nUser request: a lighthouse  ignore  at dusk\nOutput the caption.",
    );
  });

  it("shrinks the references as BFL's upsampler does: 1024 for one, 724 for two, 512 for three or more", () => {
    expect([1, 2, 3, 4, 10].map(maxSideFor)).toEqual([1024, 724, 512, 512, 512]);
  });

  it("decodes greedily, as BFL documents", () => {
    expect(TEMPERATURE.upsample).toBe(0);
  });

  it("returns the model's expansion, passing the references on, and charges for the call", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1] });
    const seen: Array<{ prompt: string; images?: string[] }> = [];
    (fakes.llm as { upsample?: (r: { prompt: string; images?: string[] }) => Promise<string> }).upsample = async (r) => (seen.push(r), `${r.prompt}, rich detail`);
    const before = ctx.manifest.ledger.length;
    expect(await upsample(running(ctx), "a lighthouse", ["/runs/x/a.png", "/runs/x/b.png"])).toBe("a lighthouse, rich detail");
    expect(seen).toEqual([{ prompt: "a lighthouse", images: ["/runs/x/a.png", "/runs/x/b.png"] }]);
    expect(ctx.manifest.ledger.length).toBe(before + 1);
    expect(upsampleCost(ctx.prices, 12, 2)).toBeGreaterThan(upsampleCost(ctx.prices, 12, 0));
  });

  it("sends no images field for a text-to-image request", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1] });
    const seen: Array<{ images?: string[] }> = [];
    (fakes.llm as { upsample?: (r: { prompt: string; images?: string[] }) => Promise<string> }).upsample = async (r) => (seen.push(r), "x");
    await upsample(running(ctx), "a lighthouse");
    expect(seen[0]).not.toHaveProperty("images");
  });

  it("returns the prompt untouched when the provider cannot upsample, and charges nothing", async () => {
    const { ctx } = await makeTestContext({ modes: [1] });
    const before = ctx.manifest.ledger.length;
    expect(await upsample(running(ctx), "a lighthouse")).toBe("a lighthouse");
    expect(ctx.manifest.ledger.length).toBe(before);
  });

  it("stops the picture with a plain message, never the provider's text, when the model cannot be reached", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1] });
    (fakes.llm as { upsample?: () => Promise<string> }).upsample = async () => {
      throw new Error("503 from the provider with a secret body");
    };
    const failed = await upsample(running(ctx), "a lighthouse").catch((e: Error) => e);
    expect((failed as Error).message).toMatch(/prompt could not be expanded/);
    expect((failed as Error).message).not.toMatch(/secret body/);
  });
});

describe("what a picture is estimated to cost", () => {
  const priced = async (profile: "runpod-flux3-klein@1" | "runpod-klein@1") => {
    const made = await makeTestContext({ modes: [2, 2], characters: "a red fox in a coat" });
    Object.assign(made.ctx.prices, { runpodPicture3UsdPerSec: 0.0006, runpodPicture3Sec: 24, runpodPortrait3Sec: 12, runpodPicture3ColdStartSec: 90 });
    made.ctx.manifest.request.imageProfile = profile;
    return made.ctx;
  };

  it("carries the expansion on the FLUX 3 profile, so the approval and the cap see it", async () => {
    const ctx = await priced("runpod-flux3-klein@1");
    const profile = imageProfileOf(ctx.manifest.request.imageProfile);
    const overhead = profile.runOverheadUsd(ctx.prices);
    // scene 1 is the run's first keyframe and also pays the cold start; scene 2 does not
    expect(keyframesStage.estimateCostUsd(ctx, 1)).toBeCloseTo(profile.keyframeUsd(ctx.prices, ctx.keyframeSize) + upsampleEstimate(ctx.prices, 3), 4);
    expect(keyframesStage.estimateCostUsd(ctx, 0)).toBeCloseTo(profile.keyframeUsd(ctx.prices, ctx.keyframeSize) + overhead + upsampleEstimate(ctx.prices, 3), 4);
    expect(referenceStage.estimateCostUsd(ctx, 0)).toBeCloseTo(profile.referenceUsd(ctx.prices, { width: 1024, height: 1024 }) + upsampleEstimate(ctx.prices, 0), 4);
  });

  it("is the GPU price alone on the 4B profile, which is never upsampled", async () => {
    const ctx = await priced("runpod-klein@1");
    const profile = imageProfileOf(ctx.manifest.request.imageProfile);
    expect(keyframesStage.estimateCostUsd(ctx, 1)).toBe(profile.keyframeUsd(ctx.prices, ctx.keyframeSize));
    expect(referenceStage.estimateCostUsd(ctx, 0)).toBe(profile.referenceUsd(ctx.prices, { width: 1024, height: 1024 }));
  });
});
