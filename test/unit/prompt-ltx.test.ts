import { describe, expect, it } from "vitest";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { scriptStage } from "../../src/stages/script.js";
import { speechCap } from "../../src/voice/words.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const base = { topic: "How tides work", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;
const timed = { targetSec: 180, sceneSec: { min: 3, max: 5 } };
const script = fakeScript(2);
const outline = { title: "T", stylePreset: script.stylePreset, styleBible: script.styleBible, hook: script.hook, hashtags: script.hashtags, parts: [{ summary: "one" }, { summary: "two" }, { summary: "three" }] };
const part = (index: number, extra: object = {}) => buildScriptPrompt({ ...base, timing: timed, ...extra, ask: { kind: "part", index, partSec: [60, 60, 60], outline, previous: index ? ["a"] : [] } });
const outlineOf = (extra: object = {}) => buildScriptPrompt({ ...base, timing: timed, ...extra, ask: { kind: "outline", partSec: [60, 60, 60] } });

// what only the rules that allow speech say: none of it may reach a run that did not ask for speech
const SPEECH_ONLY = ["lips moving precisely with every word", "talks to the camera", "invented person", "at most 14 words", "one speaker"];

describe("the prompt written for the clip model (videoPrompt)", () => {
  it("is asked of every scene, in a whole script and in a part, as one paragraph with a last sentence beginning Audio:", () => {
    for (const p of [buildScriptPrompt(base), part(1)]) {
      expect(p).toContain("- videoPrompt:");
      expect(p).toContain("one flowing paragraph in the present tense");
      expect(p).toContain('last sentence begins "Audio:"');
      expect(p).toContain("repeats the ideas of this scene's soundPrompt");
    }
  });

  it("forbids a cut, a sequence of shots and every word that draws a widescreen picture inside a vertical frame", () => {
    for (const p of [buildScriptPrompt(base), part(1)]) {
      const rule = p.split("\n").find((l) => l.startsWith("- videoPrompt, what it never asks for:"));
      expect(rule).toBeDefined();
      for (const word of ['"cinematic"', '"film"', '"widescreen"', '"letterbox"', '"black bars"', "a cut", "a sequence of shots"]) expect(rule).toContain(word);
    }
  });

  it("names one action, the camera and the light, and says what does not move when a person stays still", () => {
    const p = buildScriptPrompt(base);
    expect(p).toContain("one action");
    expect(p).toContain("the camera");
    expect(p).toContain("the light");
    expect(p).toContain("say what does not move");
  });

  it("tells every scene that does not speak to name only ambience and effects in its Audio: sentence, in a whole script and in a part, with speech or without", () => {
    for (const p of [buildScriptPrompt(base), buildScriptPrompt({ ...base, speech: true }), part(1), part(0, { speech: true })]) {
      const rule = p.split("\n").find((l) => l.startsWith('- videoPrompt, its "Audio:" sentence in a scene without speech:'));
      expect(rule, p.slice(0, 40)).toBeDefined();
      for (const word of ["only ambience and sound effects", "a voice", "speech", "a whisper", "the talk of a crowd", "singing"]) expect(rule).toContain(word);
    }
    // a speaking scene keeps its own rules: its videoPrompt quotes the sentence and its Audio: sentence has that voice
    const speaking = buildScriptPrompt({ ...base, speech: true });
    expect(speaking).toContain("lips moving precisely with every word");
    expect(speaking).toContain("with no music and no voice but the sentence in speech");
  });

  it("leaves the motionPrompt's own rules as they were, since a Wan run still reads them", () => {
    expect(buildScriptPrompt(base)).toContain("Nothing new enters the frame, nothing changes place or shape, and nobody speaks to the camera.");
  });
});

describe("a sentence a person says (speech)", () => {
  it("is not offered when the run did not ask for speech: every scene's speech is empty and no speech rule is in the prompt", () => {
    for (const p of [buildScriptPrompt(base), buildScriptPrompt({ ...base, speech: false }), part(0), part(2), outlineOf()]) {
      for (const s of SPEECH_ONLY) expect(p).not.toContain(s);
    }
    for (const p of [buildScriptPrompt(base), part(1)]) expect(p).toContain('- speech: an empty string ("") in every scene.');
  });

  it("is offered to an invented person talking to the camera, in at most two scenes, one speaker, at most 14 words, quoted in the videoPrompt", () => {
    const p = buildScriptPrompt({ ...base, speech: true });
    for (const s of SPEECH_ONLY) expect(p).toContain(s);
    expect(p).toContain("at most two scenes");
    expect(p).not.toContain('- speech: an empty string ("") in every scene.');
  });

  it("is written in the video's language, while its videoPrompt stays in English", () => {
    const p = buildScriptPrompt({ ...base, language: "tr", speech: true });
    expect(p).toMatch(/- speech: .*in Turkish/);
  });

  it("is counted in characters in a language written without spaces", () => {
    expect(buildScriptPrompt({ ...base, language: "ja", speech: true })).toContain(`at most ${speechCap("ja")} characters`);
    expect(speechCap("en")).toBe(14);
  });

  it("is offered in a long video only in its first and last parts, one scene each, so the video has at most two", () => {
    expect(part(0, { speech: true })).toContain("at most one scene of this part");
    expect(part(2, { speech: true })).toContain("at most one scene of this part");
    const middle = part(1, { speech: true });
    expect(middle).toContain('- speech: an empty string ("") in every scene.');
    expect(middle).not.toContain("lips moving precisely with every word");
  });

  it("has the outline describe the one speaker among the characters, so every part shows the same person", () => {
    expect(outlineOf({ speech: true })).toContain("styleBible.characters");
    expect(outlineOf({ speech: true })).toContain("one speaker");
    expect(outlineOf()).not.toContain("one speaker");
  });
});

describe("the run's speech setting", () => {
  it("reaches the script request and its cache key only when the run asked for speech", async () => {
    const off = await makeTestContext({ modes: "auto", sceneCount: 4, script: () => fakeScript(4) });
    const on = await makeTestContext({ modes: "auto", sceneCount: 4, script: () => fakeScript(4) });
    on.ctx.manifest.request.speech = true;
    expect(await scriptStage.inputsFor(off.ctx)).not.toHaveProperty("speech");
    expect(await scriptStage.inputsFor(on.ctx)).toHaveProperty("speech", true);
    await runPipeline(on.ctx, [scriptStage], auto);
    expect(on.fakes.llm.calls[0].speech).toBe(true);
    await runPipeline(off.ctx, [scriptStage], auto);
    expect(off.fakes.llm.calls[0].speech).toBeUndefined();
  });
});
