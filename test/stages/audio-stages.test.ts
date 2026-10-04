import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scriptCost, ttsCost } from "../../src/cost.js";
import { Script } from "../../src/manifest/schema.js";
import { probeDuration } from "../../src/media/ffmpeg.js";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { PRESETS } from "../../src/presets.js";
import { abs, paths } from "../../src/stages/paths.js";
import { scriptStage, validateScript } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("validateScript", () => {
  it("accepts a well-formed script", () => {
    expect(validateScript(fakeScript(2), 2).ok).toBe(true);
  });

  it("rejects the wrong scene count and over-long narration", () => {
    const raw = fakeScript(2);
    raw.scenes[1].narration = Array.from({ length: 23 }, () => "word").join(" ");
    const v = validateScript(raw, 3);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.problems).toContain("expected exactly 3 scenes, got 2");
      expect(v.problems).toContain("scene 2 narration has 23 words (max 22)");
    }
  });

  it("requires the 2.2 fields from Gemini, which the stored script keeps optional", () => {
    const raw = fakeScript(1) as Record<string, unknown> & { scenes: Array<Record<string, unknown>> };
    delete raw.stylePreset;
    delete raw.scenes[0].actionLevel;
    const v = validateScript(raw, 1);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.problems.join("\n")).toMatch(/stylePreset/);
      expect(v.problems.join("\n")).toMatch(/scenes\.0\.actionLevel/);
    }
    expect(Script.safeParse(raw).success).toBe(true);
  });

  it("reports schema errors with their path", () => {
    const v = validateScript({ title: "x", styleBible: {}, scenes: [] }, 1);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems.join("\n")).toMatch(/styleBible\.artStyle/);
  });
});

describe("script stage", () => {
  it("pins the run's --shots: asks the LLM for them and enforces them on its answer", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1], shots: ["cut", "cut", "cut"] }); // LLM says cut
    const before = await scriptStage.inputsFor(ctx);
    ctx.manifest.request.shots = ["cut", "continue", "continue"];
    expect(await scriptStage.inputsFor(ctx)).not.toEqual(before); // part of the cache key
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls[0].shots).toEqual(["cut", "continue", "continue"]);
    expect(ctx.manifest.script?.scenes.map((s) => s.shot)).toEqual(["cut", "continue", "continue"]);
  });

  it("pins --style: asks the LLM for it, enforces it, and lets the preset lead the art style", async () => {
    const { ctx, fakes } = await makeTestContext({ style: "dark_fantasy" }); // the fake LLM answers cinematic_history
    const before = await scriptStage.inputsFor(ctx);
    ctx.manifest.request.style = "anime";
    expect(await scriptStage.inputsFor(ctx)).not.toEqual(before); // part of the cache key
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls[0].style).toBe("anime");
    expect(ctx.manifest.script?.stylePreset).toBe("anime");
    expect(ctx.manifest.script?.styleBible.artStyle).toBe(PRESETS.anime.artStyle);
    expect(ctx.manifest.script?.styleBible.characters).toBe("a red fox"); // Gemini still writes the rest
  });

  it("keeps Gemini's preset when no --style is given", async () => {
    const { ctx } = await makeTestContext();
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.script?.stylePreset).toBe("cinematic_history");
    expect(ctx.manifest.script?.styleBible.artStyle).toBe(PRESETS.cinematic_history.artStyle);
  });

  it("stores a validated script and records its cost", async () => {
    const { ctx } = await makeTestContext();
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.script?.title).toBe("Fake run");
    expect(existsSync(abs(ctx, paths.script))).toBe(true);
    expect(ctx.manifest.ledger.map((e) => e.usd)).toEqual([scriptCost(ctx.prices)]);
  });

  it("retries once with the validation problems as feedback", async () => {
    const { ctx, fakes } = await makeTestContext({
      script: (n) => (n === 1 ? fakeScript(1) : fakeScript(2)),
    });
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls).toHaveLength(2);
    expect(fakes.llm.calls[1].feedback).toContain("expected exactly 2 scenes, got 1");
    // each answer is charged the moment it arrives, valid or not
    expect(ctx.manifest.ledger.map((e) => e.usd)).toEqual([scriptCost(ctx.prices), scriptCost(ctx.prices)]);
    expect(ctx.manifest.runStages.script?.costUsd).toBeCloseTo(2 * scriptCost(ctx.prices), 6);
  });

  it("fails after two invalid answers", async () => {
    const { ctx } = await makeTestContext({ script: () => ({ nope: true }) });
    await expect(runPipeline(ctx, [scriptStage], auto)).rejects.toThrow(/failed validation twice/);
    expect(ctx.manifest.runStages.script?.status).toBe("failed");
  });
});

describe("tts and silence stages", () => {
  it("voices each scene with neighbour context, then trims the pause and remaps words", async () => {
    const { ctx, fakes } = await makeTestContext();
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage], auto);
    const script = ctx.manifest.script!;
    expect(fakes.tts.calls[0]).toMatchObject({ voiceId: "voice-1", nextText: script.scenes[1].narration });
    expect(fakes.tts.calls[0].previousText).toBeUndefined();
    expect(fakes.tts.calls[1].previousText).toBe(script.scenes[0].narration);

    for (const scene of ctx.manifest.scenes) {
      const audio = scene.audio!;
      const raw = await probeDuration(abs(ctx, scene.tts!.raw));
      expect(audio.removedSec).toBeGreaterThan(0.25);
      expect(audio.removedSec).toBeLessThan(0.45);
      // MP3 container duration includes encoder padding (~25 ms), so compare loosely
      expect(audio.duration).toBeCloseTo(raw - audio.removedSec, 1);
      expect(audio.words).toHaveLength(9);
      expect(audio.words.at(-1)!.end).toBeLessThanOrEqual(audio.duration + 0.05);
    }
    const ttsEntries = ctx.manifest.ledger.filter((e) => e.stage === "tts");
    expect(ttsEntries.map((e) => e.usd)).toEqual(script.scenes.map((s) => ttsCost(ctx.prices, s.narration.length)));
  });
});
