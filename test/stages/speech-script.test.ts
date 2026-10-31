import { describe, expect, it } from "vitest";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { scriptStage, settleSpeech, speakingScenes, validatePart, validateScript } from "../../src/stages/script.js";
import type { ScriptRequest } from "../../src/providers/types.js";
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

  it("counts the speakers an earlier part of the script already kept towards the two", () => {
    const scenes = [{ speech: "One" }, { speech: "Two" }];
    expect(speakingScenes(scenes, true, "en", 1)).toEqual([0]);
    expect(speakingScenes(scenes, true, "en", 2)).toEqual([]);
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

describe("the script stage, for a run in a language speech was not measured in", () => {
  it("treats speech as not allowed: it does not ask for it, and clears every sentence", async () => {
    const script = fakeScript(3);
    script.scenes[1].speech = "Hello there friend";
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1], script: () => script });
    ctx.manifest.request.speech = true;
    ctx.manifest.request.language = "de";
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls[0].speech).toBeUndefined();
    expect(ctx.manifest.script!.scenes.map((s) => s.speech)).toEqual(["", "", ""]);
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

describe("a script written in parts", () => {
  const TWO_MINUTES = { targetSec: 120, sceneSec: { min: 3, max: 5 } };
  const SAID = "One said.";
  /** Fifteen scenes of ten words a part; `speak` scenes say a two-word sentence instead (as their narration too). */
  const part = (index: number, speak: number[]) => ({
    scenes: fakeScript(15).scenes.map((s, i) => ({ ...s, shot: "continue", narration: speak.includes(i) ? SAID : words(10, `p${index}s${i}`), speech: speak.includes(i) ? SAID : "" })),
  });

  it("does not exempt a later part's speaker from the word range once earlier parts kept two", () => {
    const later = part(1, [0]);
    const checked = (before: number) => validatePart(later, 1, 60, TWO_MINUTES.sceneSec, "en", undefined, 2.4, undefined, true, before);
    const first = (result: ReturnType<typeof checked>) => (result.ok ? [] : result.problems.filter((p) => p.startsWith("scene 1 narration")));
    expect(first(checked(1))).toEqual([]);
    expect(first(checked(2))).toHaveLength(1);
  });

  it("sends back the last part's third speaker, so no scene keeps a speaker's short narration without its sentence", async () => {
    const answer = (req: ScriptRequest) => {
      if (req.ask?.kind === "outline") {
        const { scenes: _none, ...head } = fakeScript(1);
        return { ...head, parts: req.ask.partSec.map((_, i) => ({ summary: `part ${i + 1}` })) };
      }
      if (req.ask?.kind !== "part") throw new Error("a long video is never asked for in one answer");
      const last = req.ask.index === req.ask.partSec.length - 1;
      if (req.ask.index === 0) return part(0, [0, 1]);
      return part(req.ask.index, last && !req.feedback ? [0] : []);
    };
    const { ctx, fakes } = await makeTestContext({ modes: "auto", timing: TWO_MINUTES, script: (_n, req) => answer(req) });
    ctx.manifest.request.speech = true;
    await runPipeline(ctx, [scriptStage], auto);
    const parts = fakes.llm.calls.filter((c) => c.ask?.kind === "part");
    const lastIndex = parts[0].ask?.kind === "part" ? parts[0].ask.partSec.length - 1 : -1;
    const lastAsks = parts.filter((c) => c.ask?.kind === "part" && c.ask.index === lastIndex);
    expect(lastAsks).toHaveLength(2);
    expect(lastAsks[1].feedback).toMatch(/scene 1 narration/);
    expect(ctx.manifest.script!.scenes.filter((s) => s.speech !== "").map((s) => s.narration)).toEqual([SAID, SAID]);
  });
});
