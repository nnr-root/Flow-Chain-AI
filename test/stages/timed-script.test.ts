import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { scriptCost } from "../../src/cost.js";
import { scriptAnswerCost, timedScriptCost } from "../../src/duration.js";
import { createManifest, layOutScenes, loadManifest } from "../../src/manifest/store.js";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { NonRetryableError } from "../../src/providers/retry.js";
import type { ScriptRequest } from "../../src/providers/types.js";
import { scriptStage, timingProblems, validateScript } from "../../src/stages/script.js";
import { fakeScript, timedScript, words } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

/*
 * A run asked for by its length (phase 7 spec): the script is told the seconds, as words, and decides the number
 * of scenes; a long one is written in parts. No test here reaches a model: the fake answers what it is told to.
 */
const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const prices = Prices.parse({});
const HALF_MINUTE = { targetSec: 30, sceneSec: { min: 3, max: 5 } };
const TWO_MINUTES = { targetSec: 120, sceneSec: { min: 3, max: 5 } };
const spent = (m: { ledger: Array<{ stage: string; usd: number }> }) => m.ledger.filter((e) => e.stage === "script").map((e) => e.usd);

/** A fake model for a video written in parts: an outline of as many parts as asked, and fifteen scenes of eleven words a part. */
const inParts = (req: ScriptRequest, scenesOf: (index: number) => number[] = () => Array(15).fill(10)): unknown => {
  if (req.ask?.kind === "outline") {
    const { scenes: _none, ...head } = fakeScript(1);
    return { ...head, parts: req.ask.partSec.map((_, i) => ({ summary: `part ${i + 1} tells the next thing` })) };
  }
  if (req.ask?.kind === "part") {
    const { index } = req.ask;
    const { scenes } = timedScript(scenesOf(index));
    // (so that one part's lines can be told from another's)
    return { scenes: scenes.map((s, i) => ({ ...s, narration: words(scenesOf(index)[i], `p${index}s${i}`), shot: "continue" })) };
  }
  throw new Error("a long video is never asked for in one answer");
};

describe("the words and scenes a length comes to", () => {
  it("accepts a script that is about as long as asked, in scenes of about the length asked", () => {
    expect(timingProblems(timedScript(Array(7).fill(10)).scenes, 30, { min: 3, max: 5 })).toEqual([]);
    // wider than what the model is told: a scene two words over or under
    expect(timingProblems(timedScript([14, 13, 12, 10, 8, 8, 6]).scenes, 30, { min: 3, max: 5 })).toEqual([]);
    expect(validateScript(timedScript(Array(7).fill(10)), 8, HALF_MINUTE).ok).toBe(true);
  });

  it("says what is wrong with one that is not, in words the model can act on", () => {
    expect(timingProblems(timedScript(Array(3).fill(12)).scenes, 30, { min: 3, max: 5 })).toEqual([
      "the script has 3 scenes; it must have between 6 and 10",
      "the narrations of the script have 36 words in all; 30 seconds of speech are about 72 (between 61 and 83)",
    ]);
    // a scene or two outside what was asked is let through: the words are what the length is checked by
    expect(timingProblems(timedScript([14, 14, 14, 14, 14]).scenes, 30, { min: 3, max: 5 })).toEqual([]);
    expect(timingProblems(timedScript([10, 10, 10, 10, 10, 10, 3, 17]).scenes, 30, { min: 3, max: 5 })).toEqual([
      "scene 7 narration has 3 words; a scene of 3-5 seconds has 7 to 12",
      "scene 8 narration has 17 words (max 16)",
    ]);
    // one length for every scene
    expect(timingProblems(timedScript(Array(6).fill(8)).scenes, 30, { min: 5, max: 5 })).toEqual([
      "scene 1 narration has 8 words; a scene of 5 seconds has 11 to 13", "scene 2 narration has 8 words; a scene of 5 seconds has 11 to 13",
      "scene 3 narration has 8 words; a scene of 5 seconds has 11 to 13", "scene 4 narration has 8 words; a scene of 5 seconds has 11 to 13",
      "scene 5 narration has 8 words; a scene of 5 seconds has 11 to 13", "scene 6 narration has 8 words; a scene of 5 seconds has 11 to 13",
      "the narrations of the script have 48 words in all; 30 seconds of speech are about 72 (between 61 and 83)",
    ]);
    // a run asked for by a number of scenes is checked as it always was
    expect(validateScript(timedScript(Array(7).fill(10)), 8).ok).toBe(false);
    expect(validateScript(timedScript(Array(8).fill(3)), 8).ok).toBe(true);
  });
});

describe("the script of a run asked for by its length", () => {
  it("tells the model the length as words and lets it decide the scenes; the run then has as many scenes as the script", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", timing: HALF_MINUTE, script: () => timedScript(Array(7).fill(10)) });
    // laid out for what was assumed until the script says
    expect(ctx.manifest.scenes).toHaveLength(8);
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls).toHaveLength(1);
    expect(fakes.llm.calls[0]).toMatchObject({ timing: HALF_MINUTE });
    const prompt = buildScriptPrompt(fakes.llm.calls[0]);
    expect(prompt).toContain("the video runs about 30 seconds when spoken");
    expect(prompt).toContain("about 72 words");
    // the whole range, not only its top: what the first real scripts did without being told
    expect(prompt).toContain("on average a scene is about 10 words");
    expect(prompt).toContain("Each scene stays on screen for 3 to 5 seconds, so each scene's narration is 7 to 12 words.");
    expect(prompt).toContain("Return between 6 and 10 scenes.");
    expect(prompt).not.toContain("Return exactly");
    expect(ctx.manifest.request.sceneCount).toBe(7);
    expect(ctx.manifest.scenes.map((s) => s.idx)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(ctx.manifest.script!.scenes).toHaveLength(7);
    expect(spent(ctx.manifest)).toEqual([scriptAnswerCost(prices, 10)]);
    // on disk too, and the run is still one the next stages can go on with
    expect((await loadManifest(ctx.dir)).scenes).toHaveLength(7);
  });

  it("is keyed on the length and not on the number of scenes, which is the script's own answer", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", timing: HALF_MINUTE, script: () => timedScript(Array(7).fill(10)) });
    const before = await scriptStage.inputsFor(ctx);
    await runPipeline(ctx, [scriptStage], auto);
    // seven scenes where eight were assumed: nothing the script was written from has changed
    expect(await scriptStage.inputsFor(ctx)).toEqual(before);
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls).toHaveLength(1);
    ctx.manifest.request.timing = { targetSec: 30, sceneSec: { min: 5, max: 5 } };
    expect(await scriptStage.inputsFor(ctx)).not.toEqual(before);
  });

  it("sends a script far from its length back once, with what was wrong, and pays for both answers", async () => {
    const { ctx, fakes, logs } = await makeTestContext({ modes: "auto", timing: HALF_MINUTE, script: (n) => timedScript(Array(n === 1 ? 3 : 7).fill(10)) });
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls).toHaveLength(2);
    expect(fakes.llm.calls[1].feedback).toContain("the script has 3 scenes; it must have between 6 and 10");
    expect(buildScriptPrompt(fakes.llm.calls[1])).toContain("Your previous answer was rejected for these reasons");
    expect(logs.join("\n")).toContain("script rejected");
    expect(spent(ctx.manifest)).toHaveLength(2);
    expect(ctx.manifest.request.sceneCount).toBe(7);
  });

  it("gives up after two, with both paid for and the run as it was laid out", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", timing: HALF_MINUTE, script: () => timedScript(Array(4).fill(12)) });
    await expect(runPipeline(ctx, [scriptStage], auto)).rejects.toThrow(/the script failed validation twice/);
    expect(fakes.llm.calls).toHaveLength(2);
    expect(spent(ctx.manifest)).toHaveLength(2);
    expect(ctx.manifest.script).toBeUndefined();
    expect(ctx.manifest.scenes).toHaveLength(8);
  });

  it("gives every scene the one choice the run was made with, however many scenes there turn out to be", async () => {
    const stills = await makeTestContext({ modes: "auto", timing: HALF_MINUTE, script: () => timedScript(Array(9).fill(9)) });
    stills.ctx.manifest.request.modeOverrides = Array(8).fill(2);
    await runPipeline(stills.ctx, [scriptStage], auto);
    expect(stills.ctx.manifest.request.modeOverrides).toEqual(Array(9).fill(2));
    const clips = await makeTestContext({ modes: [1], timing: HALF_MINUTE, script: () => timedScript(Array(6).fill(13)) });
    expect(clips.ctx.manifest.request.modes).toEqual(Array(8).fill(1));
    await runPipeline(clips.ctx, [scriptStage], auto);
    expect(clips.ctx.manifest.request.modes).toEqual(Array(6).fill(1));
    // the first scene has nothing before it to carry on from, whatever the model said
    const carried = await makeTestContext({ modes: "auto", timing: HALF_MINUTE, script: () => timedScript(Array(7).fill(10), { shots: Array(7).fill("continue") }) });
    await runPipeline(carried.ctx, [scriptStage], auto);
    expect(carried.ctx.manifest.script!.scenes.map((s) => s.shot)).toEqual(["cut", ...Array(6).fill("continue")]);
  });
});

describe("a long video's script, written in parts", () => {
  it("buys an outline and then each part, each told the last lines of the one before, and joins them into one script", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", timing: TWO_MINUTES, script: (_n, req) => inParts(req) });
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls.map((c) => c.ask?.kind)).toEqual(["outline", "part", "part"]);
    const [outline, first, second] = fakes.llm.calls;
    expect(buildScriptPrompt(outline)).toContain("It will be written in 2 parts of about 60 seconds each");
    expect(buildScriptPrompt(outline)).toContain("parts: exactly 2, in order");
    expect(first.ask).toMatchObject({ kind: "part", index: 0, previous: [] });
    expect(buildScriptPrompt(first)).toContain("You are writing part 1 of 2");
    expect(buildScriptPrompt(first)).toContain("This is the opening: scene 1 is a strong hook.");
    expect(buildScriptPrompt(first)).toContain("Do not conclude or sum up");
    expect(buildScriptPrompt(first)).toContain("this part runs about 60 seconds when spoken");
    expect(buildScriptPrompt(first)).toContain("1. part 1 tells the next thing");
    // the second part is given the first's last two lines, and is the one that ends the video
    expect(second.ask).toMatchObject({ kind: "part", index: 1, previous: [words(10, "p0s13"), words(10, "p0s14")] });
    expect(buildScriptPrompt(second)).toContain(`whose last lines were: "${words(10, "p0s13")}" "${words(10, "p0s14")}"`);
    expect(buildScriptPrompt(second)).toContain("This is the end of the video");

    const script = ctx.manifest.script!;
    expect(script.scenes).toHaveLength(30);
    expect([script.title, script.hook]).toEqual(["Fake run", "Foxes never sleep"]);
    // every part begins on a fresh picture; inside a part the model's own shots stand
    expect(script.scenes.map((s) => s.shot).filter((s) => s === "cut")).toHaveLength(2);
    expect([script.scenes[0].shot, script.scenes[15].shot]).toEqual(["cut", "cut"]);
    expect(ctx.manifest.request.sceneCount).toBe(30);
    expect(ctx.manifest.scenes).toHaveLength(30);
    // three answers, each at its own price, and nothing of the writing left in the run
    expect(spent(ctx.manifest)).toEqual([scriptCost(prices), scriptAnswerCost(prices, 20), scriptAnswerCost(prices, 20)]);
    expect(spent(ctx.manifest).reduce((a, b) => a + b, 0)).toBeCloseTo(timedScriptCost(prices, TWO_MINUTES), 4);
    expect(scriptStage.estimateCostUsd(ctx)).toBe(timedScriptCost(prices, TWO_MINUTES));
    expect(ctx.manifest.scriptParts).toBeUndefined();
    expect((await loadManifest(ctx.dir)).scriptParts).toBeUndefined();
  });

  it("sends back only the part that was wrong, and an outline with the wrong number of parts", async () => {
    let outlines = 0;
    const { ctx, fakes } = await makeTestContext({
      modes: "auto", timing: TWO_MINUTES,
      script: (_n, req) => {
        if (req.ask?.kind === "outline" && outlines++ === 0) return { ...(inParts(req) as { parts: unknown[] }), parts: [{ summary: "all of it" }] };
        // the second part comes back half as long as asked, the first time
        if (req.ask?.kind === "part" && req.ask.index === 1 && !req.feedback) return inParts(req, () => Array(7).fill(10));
        return inParts(req);
      },
    });
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls.map((c) => [c.ask?.kind, c.ask?.kind === "part" ? c.ask.index : null, c.feedback !== undefined])).toEqual([
      ["outline", null, false], ["outline", null, true], ["part", 0, false], ["part", 1, false], ["part", 1, true],
    ]);
    expect(fakes.llm.calls[1].feedback).toBe("expected exactly 2 parts, got 1");
    expect(fakes.llm.calls[4].feedback).toContain("part 2 has 7 scenes; it must have between 12 and 20");
    expect(ctx.manifest.script!.scenes).toHaveLength(30);
    expect(spent(ctx.manifest)).toHaveLength(5);
  });

  it("buys no answer again when a run that stopped in the middle is continued", async () => {
    let down = true;
    const { ctx, fakes } = await makeTestContext({
      modes: "auto", timing: { targetSec: 180, sceneSec: { min: 3, max: 5 } },
      script: (_n, req) => {
        if (down && req.ask?.kind === "part" && req.ask.index === 1) throw new NonRetryableError("the model is away");
        return inParts(req);
      },
    });
    await expect(runPipeline(ctx, [scriptStage], auto)).rejects.toThrow(/the model is away/);
    // the outline and the first part were bought, and are in the run on disk with what they cost
    const stopped = await loadManifest(ctx.dir);
    expect(stopped.scriptParts?.outline?.parts).toHaveLength(3);
    expect(stopped.scriptParts?.parts.map((p) => p.length)).toEqual([15]);
    expect(spent(stopped)).toHaveLength(2);
    expect(stopped.script).toBeUndefined();
    // a failed answer the model never gave is in no record
    expect(stopped.inFlight).toBeUndefined();

    down = false;
    const asked = fakes.llm.calls.length;
    await runPipeline({ ...ctx, manifest: stopped }, [scriptStage], auto);
    expect(fakes.llm.calls.slice(asked).map((c) => (c.ask?.kind === "part" ? c.ask.index : c.ask?.kind))).toEqual([1, 2]);
    // the part that carries on is told the last lines of the part that was kept
    expect(fakes.llm.calls[asked].ask).toMatchObject({ previous: [words(10, "p0s13"), words(10, "p0s14")] });
    const done = await loadManifest(ctx.dir);
    expect(done.script!.scenes).toHaveLength(45);
    expect(spent(done)).toHaveLength(4);
    expect(done.scriptParts).toBeUndefined();
  });

  it("does not use answers kept for other inputs", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", timing: TWO_MINUTES, script: (_n, req) => inParts(req) });
    ctx.manifest.scriptParts = { inputHash: "of another topic", outline: undefined, parts: [timedScript(Array(15).fill(10)).scenes as never] };
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls.map((c) => c.ask?.kind)).toEqual(["outline", "part", "part"]);
  });
});

describe("laying a run's scenes out again", () => {
  const models = { llm: "l", tts: "t", image: "i", video: "v" };
  const run = (sceneCount: number) => createManifest("r", { topic: "t", aspect: "9:16", sceneCount, timing: HALF_MINUTE, modeBudgetUsd: 3, modePrices: prices, voiceId: "v" }, models);

  it("keeps the scenes that are still there and adds the new ones", () => {
    const m = run(3);
    m.scenes[1].nonces = { tts: 2 };
    const kept = m.scenes[1];
    layOutScenes(m, 5);
    expect(m.scenes.map((s) => s.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(m.scenes[1]).toBe(kept);
    expect(m.request.sceneCount).toBe(5);
  });

  it("keeps what a scene that is dropped had on its way to being billed", () => {
    const m = run(4);
    m.abandonedUsd = 0.01;
    m.scenes[2].abandonedUsd = 0.02;
    // submitted and never collected: the provider bills it
    m.scenes[3].jobs = { clips: { requestId: "r1", inputHash: "h", submittedAt: "2026-10-10T00:00:00Z", expectedUsd: 0.05, chargedUsd: 0 } };
    // collected and charged: already in the ledger, so not counted twice
    m.scenes[2].jobs = { keyframes: { requestId: "r2", inputHash: "h", submittedAt: "2026-10-10T00:00:00Z", expectedUsd: 0.03, chargedUsd: 0.03, result: { url: "u" } } };
    layOutScenes(m, 2);
    expect(m.scenes).toHaveLength(2);
    expect(m.abandonedUsd).toBe(0.08);
  });

  it("is only for a run asked for by its length, and refuses choices that differ from scene to scene", () => {
    const counted = createManifest("r", { topic: "t", aspect: "9:16", sceneCount: 2, modes: [1, 2], voiceId: "v" }, models);
    expect(() => layOutScenes(counted, 3)).toThrow("only a run asked for by its length");
    const mixed = run(2);
    mixed.request.modeOverrides = [1, 2];
    expect(() => layOutScenes(mixed, 3)).toThrow("cannot have pinned modes per scene");
  });
});
