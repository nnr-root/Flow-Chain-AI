import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sceneWords, totalWords, typicalSceneWords, WORDS_PER_SECOND, wordsPerSecond } from "../../src/duration.js";
import { RunRequest } from "../../src/manifest/schema.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { timingProblems } from "../../src/stages/script.js";
import { PRESETS } from "../../src/presets.js";
import { captionStyleFor } from "../../src/stages/look.js";
import { BUILT_IN_VOICES, fontCovers, voicePace, LANGUAGE_IN_ENGLISH, SPEECH_LANGUAGES, VOICE_DESIGNS, VOICES } from "../../src/voice/language.js";
import { designedVoices } from "../../src/voice/library.js";
import { SAMPLE_LINES } from "../../scripts/make-voices.js";
import { timedScript } from "../fakes/providers.js";

/* The language a video is told in, and the voices that tell it (phase 7 spec §13). */
const timing = { targetSec: 30, sceneSec: { min: 3, max: 5 } };
const base = { topic: "foxes", sceneCount: 8, aspect: "9:16" as const };

describe("the languages and voices on offer", () => {
  const recorded = JSON.parse(readFileSync("worker-voice/voices/voices.json", "utf8")) as Record<string, Record<string, string>>;

  it("are exactly the voices the voice worker has, each with the English clip every other language is spoken from", () => {
    // the worker's image has its own voices; every other voice on the list is designed, and was asked for in words
    expect([...BUILT_IN_VOICES].sort()).toEqual(Object.keys(recorded).sort());
    for (const voice of Object.keys(VOICES)) {
      if (!BUILT_IN_VOICES.includes(voice as never)) expect(VOICE_DESIGNS[voice as keyof typeof VOICE_DESIGNS], voice).toBeTruthy();
    }
    // a description goes to the model inside one pair of parentheses
    for (const d of Object.values(VOICE_DESIGNS)) expect(d).not.toMatch(/[()]/);
    for (const voice of BUILT_IN_VOICES) {
      // English is what a language without a clip of its own falls back to, in the worker
      expect(Object.keys(recorded[voice]), voice).toContain("en");
      for (const language of Object.keys(recorded[voice])) {
        expect(existsSync(`worker-voice/voices/${voice}.${language}.flac`), `${voice}.${language}`).toBe(true);
        // a voice has a clip only in a language a video can be asked for in
        expect(Object.keys(SPEECH_LANGUAGES), language).toContain(language);
      }
    }
  });

  it("are twenty languages, each with its own name, its English name, a line to say and a measured pace", () => {
    const codes = Object.keys(SPEECH_LANGUAGES);
    expect(codes).toHaveLength(20);
    // the voice worker takes a language as two letters
    for (const code of codes) expect(code).toMatch(/^[a-z]{2}$/);
    expect(Object.keys(LANGUAGE_IN_ENGLISH).sort()).toEqual([...codes].sort());
    expect(Object.keys(SAMPLE_LINES).sort()).toEqual([...codes].sort());
    expect(new Set(Object.values(SAMPLE_LINES)).size).toBe(20);
    for (const code of codes) {
      // a pace of its own, within what speech can be, and never the English one by default
      expect(wordsPerSecond(code), code).toBeGreaterThan(1);
      expect(wordsPerSecond(code), code).toBeLessThan(4);
      if (code !== "en") expect(wordsPerSecond(code), code).not.toBe(WORDS_PER_SECOND);
      // and a scene of any length it can be asked for at is a number of words a script can have
      for (let min = 2; min <= 5; min++) for (let max = min; max <= 5; max++) {
        const words = sceneWords({ min, max }, wordsPerSecond(code));
        expect(words.min, `${code} ${min}-${max}`).toBeGreaterThanOrEqual(2);
        expect(words.max, `${code} ${min}-${max}`).toBeGreaterThanOrEqual(words.min);
        expect(words.max, `${code} ${min}-${max}`).toBeLessThanOrEqual(16);
      }
    }
  });

  it("have a sample to listen to for every voice in every language, said by the engine and heard as its line", () => {
    const listed = JSON.parse(readFileSync("web/content/voice-samples.json", "utf8")) as { samples: Record<string, Record<string, { seconds: number; words: number }>> };
    // every voice that can be chosen: the worker's own and the designed ones whose clip has been made
    for (const voice of [...BUILT_IN_VOICES, ...designedVoices()]) {
      for (const language of Object.keys(SPEECH_LANGUAGES)) {
        expect(existsSync(`web/public/voices/${voice}.${language}.mp3`), `${voice}.${language}`).toBe(true);
        const sample = listed.samples[voice]?.[language];
        expect(sample, `${voice}.${language}`).toBeDefined();
        // the line it was made from is the one in the command that makes them
        expect(sample.words, `${voice}.${language}`).toBe(SAMPLE_LINES[language as keyof typeof SAMPLE_LINES].split(/\s+/).length);
        expect(sample.seconds).toBeGreaterThan(3);
        expect(sample.seconds).toBeLessThan(15);
      }
    }
  });

  it("gives a video's captions a typeface that has its language's letters, and leaves the others their style's own", () => {
    const run = (language: string | undefined, style: string) => ({ request: { style, language, render: { captionStyle: "preset" } }, script: undefined }) as never;
    // the cyberpunk face has no Turkish or Russian letters; the history one has Turkish but not Russian or Greek
    expect(captionStyleFor(run("en", "cyberpunk")).font.file).toBe("Orbitron-Variable.ttf");
    expect(captionStyleFor(run(undefined, "cyberpunk")).font.file).toBe("Orbitron-Variable.ttf");
    expect(captionStyleFor(run("tr", "cyberpunk")).font.file).toBe("Montserrat-ExtraBold.ttf");
    expect(captionStyleFor(run("tr", "cinematic_history")).font.file).toBe("Cinzel-Variable.ttf");
    expect(captionStyleFor(run("ru", "cinematic_history")).font.file).toBe("Montserrat-ExtraBold.ttf");
    // Greek is in one face only
    expect(captionStyleFor(run("el", "cinematic_history")).font.file).toBe("Inter-SemiBold.ttf");
    // everything else of the style stays
    const swapped = captionStyleFor(run("tr", "cyberpunk"));
    const own = captionStyleFor(run("en", "cyberpunk"));
    expect({ ...swapped, font: own.font }).toEqual(own);
    // whatever the language and the style, the face that is used has the letters
    for (const language of Object.keys(SPEECH_LANGUAGES)) {
      for (const style of Object.keys(PRESETS)) expect(fontCovers(captionStyleFor(run(language, style)).font.file, language as never), `${language} ${style}`).toBe(true);
    }
  });

  it("are the only languages a run can be asked for in, and a run need not say one", () => {
    const run = { topic: "t", aspect: "9:16", sceneCount: 2, modes: [1, 1], voiceId: "narrator-m" };
    expect(RunRequest.parse(run).language).toBeUndefined();
    for (const language of Object.keys(SPEECH_LANGUAGES)) expect(RunRequest.parse({ ...run, language }).language).toBe(language);
    for (const other of ["ar", "zh", "ja", "hi", "english", ""]) expect(RunRequest.safeParse({ ...run, language: other }).success, other).toBe(false);
  });
});

describe("a voice that speaks slower or faster than the narrators", () => {
  it("is asked for fewer or more words, by its pace measured in all twenty languages", () => {
    const listed = JSON.parse(readFileSync("web/content/voice-samples.json", "utf8")) as { samples: Record<string, Record<string, { seconds: number; words: number }>> };
    const rate = (v: string, l: string) => listed.samples[v][l].words / listed.samples[v][l].seconds;
    for (const voice of [...BUILT_IN_VOICES, ...designedVoices()]) {
      const langs = Object.keys(SPEECH_LANGUAGES);
      const measured = langs.reduce((sum, l) => sum + rate(voice, l) / ((rate("narrator-m", l) + rate("narrator-f", l)) / 2), 0) / langs.length;
      // the pace on the list is within a twentieth of what the samples say
      expect(Math.abs(voicePace(voice) - measured), voice).toBeLessThan(0.05);
    }
    expect(voicePace(undefined)).toBe(1);
    expect(voicePace("someone")).toBe(1);
    expect(wordsPerSecond("en", "calm")).toBe(1.63);
    expect(buildScriptPrompt({ ...base, timing, voiceId: "calm" })).toContain("about 49 words");
    expect(buildScriptPrompt({ ...base, timing, voiceId: "host" })).toContain("about 83 words");
    expect(buildScriptPrompt({ ...base, timing, voiceId: "narrator-m" })).toContain("about 72 words");
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
    expect(totalWords(30, tr)).toBe(57);
    expect(sceneWords({ min: 3, max: 5 }, tr)).toEqual({ min: 5, max: 10 });
    expect(typicalSceneWords({ min: 3, max: 5 }, tr)).toBe(8);
    const prompt = buildScriptPrompt({ ...base, timing, language: "tr" });
    expect(prompt).toContain("about 57 words");
    expect(prompt).toContain("each scene's narration is 5 to 10 words");
    // a language is named to the model by its English name
    expect(buildScriptPrompt({ ...base, timing, language: "vi" })).toContain("in Vietnamese");
    // and checked against the same: sixty words pass in Turkish and are too few in English
    const sixty = timedScript(Array(7).fill(8).concat([4])).scenes;
    expect(timingProblems(sixty, 30, timing.sceneSec, "the script", tr)).toEqual([]);
    expect(timingProblems(sixty, 30, timing.sceneSec).join(" ")).toContain("have 60 words in all");
  });
});
