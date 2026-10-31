import { describe, expect, it } from "vitest";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { scriptStage, settleSpeech, speakingScenes, validateScript } from "../../src/stages/script.js";
import { speechCap } from "../../src/voice/words.js";
import { fakeScript, timedScript, words } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Task 7's review, ruled for phase 15: what the script says about speech is put right in code, never by a paid retry,
// because a speaking scene buys a clip of its own.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const HALF_MINUTE = { targetSec: 30, sceneSec: { min: 3, max: 5 } };

describe("which scenes of a script may speak", () => {
  it("is none in a run that does not allow speech", () => {
    expect(speakingScenes([{ speech: "Hi there" }], false, "en")).toEqual([]);
  });

  it("is the first two with a sentence within the cap, leaving out empty, blank and over-long ones", () => {
    const long = words(speechCap("en") + 1);
    const scenes = [{ speech: long }, { speech: "" }, { speech: "  " }, { speech: "One" }, {}, { speech: "Two" }, { speech: "Three" }];
    expect(speakingScenes(scenes, true, "en")).toEqual([3, 5]);
    expect(speakingScenes([{ speech: words(speechCap("en")) }], true, "en")).toEqual([0]);
  });

  it("counts a language without spaces in characters", () => {
    expect(speakingScenes([{ speech: "你".repeat(speechCap("zh")) }, { speech: "你".repeat(speechCap("zh") + 1) }], true, "zh")).toEqual([0]);
  });

  it("clears every other sentence and makes a speaking scene's narration its sentence", () => {
    const scenes = [
      { narration: "a", speech: "First line." },
      { narration: "b", speech: "Second line." },
      { narration: "c", speech: "Third line." },
      { narration: "d" },
    ];
    settleSpeech(scenes, true, "en");
    expect(scenes).toEqual([
      { narration: "First line.", speech: "First line." },
      { narration: "Second line.", speech: "Second line." },
      { narration: "c", speech: "" },
      // (a script written before speech existed is left without the field)
      { narration: "d" },
    ]);
  });
});

describe("the script stage", () => {
  it("clears every sentence in a run that does not allow speech", async () => {
    const script = fakeScript(3);
    script.scenes[1].speech = "Hello there friend";
    const { ctx } = await makeTestContext({ modes: [1, 1, 1], script: () => script });
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.script!.scenes.map((s) => s.speech)).toEqual(["", "", ""]);
    expect(ctx.manifest.script!.scenes[1].narration).toBe(fakeScript(3).scenes[1].narration);
  });

  it("keeps the first two speakers within the cap without asking again, and gives them their sentence as narration", async () => {
    const script = fakeScript(4);
    const sentences = [words(speechCap("en") + 2), "One said.", "Two said.", "Three said."];
    script.scenes.forEach((s, i) => (s.speech = sentences[i]));
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1, 1], script: () => script });
    ctx.manifest.request.speech = true;
    ctx.manifest.request.language = "en";
    await runPipeline(ctx, [scriptStage], auto);
    const scenes = ctx.manifest.script!.scenes;
    expect(fakes.llm.calls).toHaveLength(1);
    expect(scenes.map((s) => s.speech)).toEqual(["", "One said.", "Two said.", ""]);
    expect(scenes.map((s) => s.narration)).toEqual([fakeScript(4).scenes[0].narration, "One said.", "Two said.", fakeScript(4).scenes[3].narration]);
  });
});

describe("the script's word range", () => {
  // seven scenes of 11 words and one short sentence spoken in its own clip
  const answer = () => {
    const s = timedScript([11, 11, 11, 11, 11, 11, 11]);
    Object.assign(s.scenes[2], { narration: "Hello there friend", speech: "Hello there friend" });
    return s;
  };
  const third = (problems: string[]) => problems.filter((p) => p.startsWith("scene 3 narration"));

  it("does not hold a speaking scene to an ordinary scene's number of words", () => {
    const result = validateScript(answer(), 7, HALF_MINUTE, "en", undefined, 2.4, true);
    expect(result.ok ? [] : third(result.problems)).toEqual([]);
  });

  it("still holds that scene to it where the run does not allow speech", () => {
    const result = validateScript(answer(), 7, HALF_MINUTE, "en", undefined, 2.4);
    expect(result.ok).toBe(false);
    expect(third(result.ok ? [] : result.problems)).toHaveLength(1);
  });
});
