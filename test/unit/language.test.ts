import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { maxSceneUnits, sceneWords, totalWords, typicalSceneWords, WORDS_PER_SECOND, wordsPerSecond } from "../../src/duration.js";
import { RunRequest } from "../../src/manifest/schema.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { timingProblems } from "../../src/stages/script.js";
import { PRESETS } from "../../src/presets.js";
import { captionStyleFor } from "../../src/stages/look.js";
import { BUILT_IN_VOICES, fontCovers, voicePace, LANGUAGE_IN_ENGLISH, OWN_VOICE_IDS, SPEECH_LANGUAGES, VOICE_DESIGNS, VOICES } from "../../src/voice/language.js";
import { hostedCatalogue, hostedLanguages } from "../../src/voice/hosted.js";
import { countUnits, isUnspaced } from "../../src/voice/words.js";
import { VOICE_PACE } from "../../src/voice/rates.js";
import { clipLanguages, designedVoices } from "../../src/voice/library.js";
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
    // every voice, the worker's own included, is described, so that it can be made in any language
    for (const voice of OWN_VOICE_IDS) expect(VOICE_DESIGNS[voice], voice).toBeTruthy();
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

  it("are thirty-one languages, each with its own name, its English name, a line to say and a measured pace", () => {
    const codes = Object.keys(SPEECH_LANGUAGES);
    expect(codes).toHaveLength(31);
    // Swahili was taken out (phase 7 spec §17): too few voices native to it
    expect(codes).not.toContain("sw");
    // the voice worker takes a language as two letters
    for (const code of codes) expect(code).toMatch(/^[a-z]{2}$/);
    expect(Object.keys(LANGUAGE_IN_ENGLISH).sort()).toEqual([...codes].sort());
    expect(Object.keys(SAMPLE_LINES).sort()).toEqual([...codes].sort());
    expect(new Set(Object.values(SAMPLE_LINES)).size).toBe(31);
    for (const code of codes) {
      // a pace of its own, within what speech can be (characters a second in Chinese and Japanese), and never the English one by default
      expect(wordsPerSecond(code), code).toBeGreaterThan(1);
      expect(wordsPerSecond(code), code).toBeLessThan(isUnspaced(code) ? 10 : 4);
      if (code !== "en") expect(wordsPerSecond(code), code).not.toBe(WORDS_PER_SECOND);
      // and a scene of any length it can be asked for at is a number of words a script can have
      for (let min = 2; min <= 5; min++) for (let max = min; max <= 5; max++) {
        const most = maxSceneUnits(code, wordsPerSecond(code));
        const words = sceneWords({ min, max }, wordsPerSecond(code), most);
        expect(words.min, `${code} ${min}-${max}`).toBeGreaterThanOrEqual(2);
        expect(words.max, `${code} ${min}-${max}`).toBeGreaterThanOrEqual(words.min);
        expect(words.max, `${code} ${min}-${max}`).toBeLessThanOrEqual(most);
      }
    }
  });

  it("have a sample to listen to for every voice in every language, said by the engine and heard as its line", () => {
    const listed = JSON.parse(readFileSync("web/content/voice-samples.json", "utf8")) as { samples: Record<string, Record<string, { seconds: number; words: number }>> };
    // every hosted voice chosen, in every language it has a voice of its own chosen in (phase 5 spec §11), but
    // the ones whose samples the account's monthly characters ran out before (phase 7 spec §17.5): when they are
    // made, this list is emptied
    const missing: string[] = [];
    for (const voice of Object.keys(hostedCatalogue().voices)) {
      for (const language of hostedLanguages(voice)) {
        if (!existsSync(`web/public/voices/${voice}.${language}.mp3`)) {
          missing.push(`${voice}.${language}`);
          continue;
        }
        expect(listed.samples[voice]?.[language]?.words, `${voice}.${language}`).toBe(countUnits(SAMPLE_LINES[language as keyof typeof SAMPLE_LINES], language));
      }
    }
    expect(missing.sort()).toEqual([...SAMPLES_NOT_MADE].sort());
    // every sample is of the length a sample is (the Japanese line is the longest: twenty seconds in the calmest voice)
    for (const [voice, by] of Object.entries(listed.samples)) {
      for (const [language, sample] of Object.entries(by)) {
        expect(sample.seconds, `${voice}.${language}`).toBeGreaterThan(3);
        expect(sample.seconds, `${voice}.${language}`).toBeLessThan(20);
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
    for (const other of ["sw", "th", "he", "english", ""]) expect(RunRequest.safeParse({ ...run, language: other }).success, other).toBe(false);
  });
});

describe("a voice that speaks slower or faster than the narrators", () => {
  it("is asked for fewer or more words, by its pace measured in each language it speaks (phase 7 spec §20)", () => {
    // each voice is another person in each language: its pace is the language's own, from its sample
    for (const [voice, by] of Object.entries(VOICE_PACE)) {
      expect(Object.hasOwn(VOICES, voice), voice).toBe(true);
      for (const [language, pace] of Object.entries(by)) {
        expect(Object.hasOwn(SPEECH_LANGUAGES, language), `${voice}.${language}`).toBe(true);
        expect(pace, `${voice}.${language}`).toBeGreaterThan(0.5);
        expect(pace, `${voice}.${language}`).toBeLessThan(2);
        expect(Math.abs(pace - 1), `${voice}.${language}`).toBeGreaterThanOrEqual(0.05);
        expect(voicePace(voice, language)).toBe(pace);
      }
    }
    // within a twentieth of the narrators, and anyone unknown, is the narrators' pace
    expect(voicePace(undefined)).toBe(1);
    expect(voicePace("someone", "en")).toBe(1);
    // a faster voice is asked for more words, a slower one for fewer, by its pace in the video's language
    const [fast, slow] = [...Object.entries(VOICE_PACE)].flatMap(([v, by]) => (by.en ? [[v, by.en] as const] : [])).sort((a, b) => b[1] - a[1]).filter((_, i, all) => i === 0 || i === all.length - 1);
    expect(wordsPerSecond("en", fast[0])).toBe(Math.round(WORDS_PER_SECOND * fast[1] * 100) / 100);
    expect(wordsPerSecond("en", fast[0])).toBeGreaterThan(wordsPerSecond("en", slow[0]));
    expect(buildScriptPrompt({ ...base, timing, voiceId: fast[0] })).toContain(`about ${Math.round(30 * wordsPerSecond("en", fast[0]))} words`);
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
    // (the figures are the measured ones: phase 7 spec §20)
    const tr = wordsPerSecond("tr", "narrator-m");
    expect(wordsPerSecond("tr")).toBeLessThan(WORDS_PER_SECOND);
    const each = sceneWords({ min: 3, max: 5 }, tr);
    const prompt = buildScriptPrompt({ ...base, timing, language: "tr" });
    expect(prompt).toContain(`about ${totalWords(30, tr)} words`);
    expect(prompt).toContain(`each scene's narration is ${each.min} to ${each.max} words`);
    // a language is named to the model by its English name
    expect(buildScriptPrompt({ ...base, timing, language: "vi" })).toContain("in Vietnamese");
    // and checked against the same: what thirty seconds of Turkish is passes in Turkish, and is too few in English
    const perScene = Math.round(totalWords(30, tr) / 7);
    const turkish = timedScript(Array(7).fill(perScene)).scenes;
    expect(timingProblems(turkish, 30, timing.sceneSec, "the script", tr)).toEqual([]);
    expect(timingProblems(turkish, 30, timing.sceneSec).join(" ")).toContain(`have ${perScene * 7} words in all`);
  });
});

/** The hosted voices whose samples are not made yet (the account ran out on 2026-10-12; made on 2026-10-15). */
const SAMPLES_NOT_MADE: string[] = [];
