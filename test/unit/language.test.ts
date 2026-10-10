import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sceneWords, totalWords, typicalSceneWords, WORDS_PER_SECOND, wordsPerSecond } from "../../src/duration.js";
import { RunRequest } from "../../src/manifest/schema.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { timingProblems } from "../../src/stages/script.js";
import { LANGUAGE_IN_ENGLISH, SPEECH_LANGUAGES, VOICES } from "../../src/voice/language.js";
import { timedScript } from "../fakes/providers.js";

/* The language a video is told in, and the voices that tell it (phase 7 spec §13). */
const timing = { targetSec: 30, sceneSec: { min: 3, max: 5 } };
const base = { topic: "foxes", sceneCount: 8, aspect: "9:16" as const };

describe("the languages and voices on offer", () => {
  const recorded = JSON.parse(readFileSync("worker-voice/voices/voices.json", "utf8")) as Record<string, Record<string, string>>;

  it("are exactly the voices the voice worker has, each with a clip in every language", () => {
    expect(Object.keys(VOICES).sort()).toEqual(Object.keys(recorded).sort());
    for (const voice of Object.keys(VOICES)) {
      expect(Object.keys(recorded[voice]).sort(), voice).toEqual(Object.keys(SPEECH_LANGUAGES).sort());
      for (const language of Object.keys(SPEECH_LANGUAGES)) expect(existsSync(`worker-voice/voices/${voice}.${language}.flac`), `${voice}.${language}`).toBe(true);
    }
    expect(Object.keys(LANGUAGE_IN_ENGLISH).sort()).toEqual(Object.keys(SPEECH_LANGUAGES).sort());
  });

  it("have a sample to listen to for every voice in every language", () => {
    for (const voice of Object.keys(VOICES)) {
      for (const language of Object.keys(SPEECH_LANGUAGES)) expect(existsSync(`web/public/voices/${voice}.${language}.mp3`), `${voice}.${language}`).toBe(true);
    }
  });

  it("are the only languages a run can be asked for in, and a run need not say one", () => {
    const run = { topic: "t", aspect: "9:16", sceneCount: 2, modes: [1, 1], voiceId: "narrator-m" };
    expect(RunRequest.parse(run).language).toBeUndefined();
    for (const language of Object.keys(SPEECH_LANGUAGES)) expect(RunRequest.parse({ ...run, language }).language).toBe(language);
    expect(RunRequest.safeParse({ ...run, language: "de" }).success).toBe(false);
  });
});

describe("a script in a language that was asked for", () => {
  it("is told to write what is heard in it, and what the picture models read in English", () => {
    const whole = buildScriptPrompt({ ...base, timing, language: "tr" });
    expect(whole).toContain("- Language: write the title, the hook and every narration in Turkish, the way a native speaker would say it aloud. Write every imagePrompt and motionPrompt, and the styleBible, in English.");
    const outline = buildScriptPrompt({ ...base, timing: { ...timing, targetSec: 120 }, language: "tr", ask: { kind: "outline", partSec: [60, 60] } });
    expect(outline).toContain("write the title, the hook and every part's summary in Turkish");
    const part = buildScriptPrompt({ ...base, timing: { ...timing, targetSec: 120 }, language: "en", ask: { kind: "part", index: 0, partSec: [60, 60], outline: { title: "T", stylePreset: "anime", styleBible: { artStyle: "a", characters: "none", palette: "p" }, hook: "h", parts: [{ summary: "one" }, { summary: "two" }] }, previous: [] } });
    expect(part).toContain("- Language: write every narration in English");
    // a run that names no language is asked as it always was
    expect(buildScriptPrompt({ ...base, timing })).not.toContain("Language:");
    expect(buildScriptPrompt(base)).not.toContain("Language:");
  });

  it("is asked for fewer words where the voice speaks fewer in a second", () => {
    expect([wordsPerSecond(), wordsPerSecond("en"), wordsPerSecond("xx")]).toEqual([WORDS_PER_SECOND, WORDS_PER_SECOND, WORDS_PER_SECOND]);
    const tr = wordsPerSecond("tr");
    expect(tr).toBeLessThan(WORDS_PER_SECOND);
    expect(totalWords(30, tr)).toBe(60);
    expect(sceneWords({ min: 3, max: 5 }, tr)).toEqual({ min: 6, max: 10 });
    expect(typicalSceneWords({ min: 3, max: 5 }, tr)).toBe(8);
    const prompt = buildScriptPrompt({ ...base, timing, language: "tr" });
    expect(prompt).toContain("about 60 words");
    expect(prompt).toContain("each scene's narration is 6 to 10 words");
    // and checked against the same: sixty words pass in Turkish and are too few in English
    const sixty = timedScript(Array(7).fill(8).concat([4])).scenes;
    expect(timingProblems(sixty, 30, timing.sceneSec, "the script", tr)).toEqual([]);
    expect(timingProblems(sixty, 30, timing.sceneSec).join(" ")).toContain("have 60 words in all");
  });
});
