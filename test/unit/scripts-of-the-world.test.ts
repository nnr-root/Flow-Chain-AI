import { describe, expect, it } from "vitest";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { wordsFromAlignment } from "../../src/providers/elevenlabs.js";
import { newRunVoice } from "../../src/providers/new-run.js";
import { loadEnv } from "../../src/config.js";
import { captionPages, wordsToCaptions } from "../../src/media/remotion/caption-pages.js";
import { hookLines } from "../../src/media/remotion/timeline.js";
import { SCRIPT_FACES } from "../../src/media/remotion/styles.js";
import { timingProblems, validateScript } from "../../src/stages/script.js";
import { estimateNarrationSec } from "../../src/studio/draft.js";
import { hostedModelFor } from "../../src/voice/hosted.js";
import { fontCovers, OWN_VOICE_LANGUAGES, SPEECH_LANGUAGES } from "../../src/voice/language.js";
import { countUnits, isRightToLeft, lengthUnit, splitWords, wordJoiner } from "../../src/voice/words.js";
import { wordsPerSecond } from "../../src/duration.js";
import { fakeScript } from "../fakes/providers.js";
import { normalizeHashtags } from "../../src/hashtags.js";

// Phase 7 spec §17: languages written without spaces, right to left, and in scripts of their own.

const ZH = "每一个伟大的故事，都始于一个问题。请陪我片刻。";
const JA = "すべての偉大な物語は、ひとつの問いから始まります。";

describe("words in a language without spaces", () => {
  it("are found by the segmenter, with the punctuation after a word kept on it", () => {
    expect(splitWords(ZH, "zh")).toEqual(["每", "一个", "伟大", "的", "故事，", "都", "始", "于", "一个", "问题。", "请", "陪", "我", "片刻。"]);
    expect(splitWords(JA, "ja").at(-1)).toBe("ます。");
    // a spaced language is split on its spaces, as before
    expect(splitWords("Her büyük hikâye", "tr")).toEqual(["Her", "büyük", "hikâye"]);
    expect(splitWords("Her büyük hikâye")).toEqual(["Her", "büyük", "hikâye"]);
  });

  it("are counted in characters, without their punctuation, and a script is told so", () => {
    expect(countUnits(ZH, "zh")).toBe(20);
    expect(countUnits("一个 问题", "zh")).toBe(4);
    expect(countUnits(ZH, "en")).toBe(1);
    expect([lengthUnit("zh"), lengthUnit("ja"), lengthUnit("ko"), lengthUnit("ar"), lengthUnit()]).toEqual(["characters", "characters", "words", "words", "words"]);
    const base = { topic: "t", aspect: "9:16", sceneCount: 3, voiceId: "narrator-m", timing: { targetSec: 30, sceneSec: { min: 3, max: 5 } } } as const;
    const zh = buildScriptPrompt({ ...base, language: "zh" });
    expect(zh).toContain(`about ${Math.round(30 * wordsPerSecond("zh"))} characters`);
    expect(zh).toMatch(/hook: a punchy title of at most \d+ characters/);
    // and a spaced language is told in words, as before
    expect(buildScriptPrompt({ ...base, language: "tr" })).toContain("about 51 words");
  });

  it("are what a script's length is checked by, against limits that say as much as the words would", () => {
    const rate = wordsPerSecond("zh");
    // three scenes of 4 seconds in Chinese: about 17 characters each, which in words would be one "word" each
    const scene = "一".repeat(Math.round(4 * rate));
    expect(timingProblems([{ narration: scene }, { narration: scene }, { narration: scene }], 12, { min: 4, max: 4 }, "the script", rate, "zh")).toEqual([]);
    const counted = timingProblems([{ narration: scene }, { narration: scene }, { narration: scene }], 12, { min: 4, max: 4 }, "the script", rate);
    expect(counted.join(" ")).toMatch(/has 1 words/);
    // a hook of twenty-five characters is too long for the screen; one of nine is not (twelve at most)
    const script = (hook: string) => {
      const s = fakeScript(3);
      return { ...s, hook, scenes: s.scenes.map((x) => ({ ...x, narration: scene })) };
    };
    const ok = validateScript(script("一个伟大的问题开始"), 3, undefined, "zh");
    const long = validateScript(script("一".repeat(25)), 3, undefined, "zh");
    expect(ok.ok || ok.problems.join(" ")).toBe(true);
    expect(long.ok ? "" : long.problems.join(" ")).toMatch(/hook has 25 characters/);
  });

  it("are timed in a draft by their voice's rate, not as letters of an alphabet", () => {
    expect(estimateNarrationSec("一".repeat(42), "zh")).toBeCloseTo(42 / wordsPerSecond("zh"), 1);
    expect(estimateNarrationSec("x".repeat(42))).toBeLessThan(estimateNarrationSec("一".repeat(42), "zh"));
  });
});

describe("captions in every language", () => {
  it("set words side by side in a language without spaces, and with spaces in the others", () => {
    const words = [{ text: "伟大", start: 0, end: 0.3 }, { text: "的", start: 0.3, end: 0.4 }, { text: "故事。", start: 0.4, end: 0.8 }, { text: "请", start: 1, end: 1.2 }];
    const zh = wordsToCaptions(words, 3, "zh");
    expect(zh.map((c) => c.text)).toEqual(["伟大", "的", "故事。", "请"]);
    expect(captionPages(zh)[0].text).toBe("伟大的故事。");
    expect(wordsToCaptions(words, 3).map((c) => c.text)).toEqual(["伟大", " 的", " 故事。", " 请"]);
    expect([wordJoiner("ja"), wordJoiner("ar"), wordJoiner()]).toEqual(["", " ", " "]);
  });

  it("end a page after the full stops and commas of other scripts", () => {
    for (const stop of ["。", "，", "！", "؟", "،", "।"]) {
      const words = [{ text: `a${stop}`, start: 0, end: 0.5 }, { text: "b", start: 0.5, end: 1 }, { text: "c", start: 1, end: 1.5 }];
      expect(wordsToCaptions(words, 5)[0].pageBreakAfter, stop).toBe(true);
    }
  });

  it("are laid over a hosted line's own times, word by word, in a language without spaces", () => {
    const text = "伟大的故事。";
    const chars = [...text];
    const words = wordsFromAlignment({ characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.25), character_end_times_seconds: chars.map((_, i) => i * 0.25 + 0.25) }, "zh");
    expect(words).toEqual([{ text: "伟大", start: 0, end: 0.5 }, { text: "的", start: 0.5, end: 0.75 }, { text: "故事。", start: 0.75, end: 1.5 }]);
  });

  it("put a title of a language without spaces on lines without them", () => {
    const fit = (line: string) => 1000 / line.length;
    const { lines } = hookLines(["伟大", "的", "故事"], fit, 500, "");
    expect(lines.join("")).toBe("伟大的故事");
    expect(lines.every((l) => !l.includes(" "))).toBe(true);
  });

  it("run right to left in Arabic only", () => {
    expect(SPEECH_LANGUAGE_CODES_RTL()).toEqual(["ar"]);
  });

  it("are set in a face with the letters of every language, its own for the scripts the styles' faces lack", () => {
    for (const lang of ["ja", "zh", "ko", "hi", "ar"]) {
      expect(SCRIPT_FACES[lang], lang).toBeDefined();
      expect(fontCovers(SCRIPT_FACES[lang].file, lang as never), lang).toBe(true);
    }
    // Japanese and Chinese share characters but not shapes: each has its own face
    expect(SCRIPT_FACES.ja.file).not.toBe(SCRIPT_FACES.zh.file);
  });
});

describe("the voice model a language is spoken by", () => {
  it("is the one chosen where it speaks the language, else a 2.5 model that does", () => {
    expect(hostedModelFor("tr", "eleven_multilingual_v2")).toBe("eleven_multilingual_v2");
    expect(hostedModelFor("ja", "eleven_multilingual_v2")).toBe("eleven_multilingual_v2");
    // the default model does not speak these three
    for (const lang of ["no", "vi", "hu"]) expect(hostedModelFor(lang, "eleven_multilingual_v2"), lang).toBe("eleven_turbo_v2_5");
    expect(hostedModelFor(undefined, "eleven_multilingual_v2")).toBe("eleven_multilingual_v2");
    // every language on offer has a model that speaks it
    for (const lang of Object.keys(SPEECH_LANGUAGES)) expect(() => hostedModelFor(lang, "eleven_multilingual_v2"), lang).not.toThrow();
    expect(() => hostedModelFor("sw", "eleven_multilingual_v2")).toThrow(/no voice model speaks "sw"/);
  });

  it("freezes a new run in that model, and the own voice refuses a language it does not speak", () => {
    const hosted = loadEnv({ GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e" });
    expect(newRunVoice(hosted, "vi").model).toBe("eleven_turbo_v2_5");
    expect(newRunVoice(hosted, "ar").model).toBe("eleven_multilingual_v2");
    const own = loadEnv({ GEMINI_API_KEY: "g", RUNPOD_VOICE_ENDPOINT: "ep-v" });
    expect(newRunVoice(own, "tr").model).toBe("runpod:ep-v/voice-voxcpm2@1");
    expect(() => newRunVoice(own, "ja")).toThrow(/does not speak "ja"/);
    expect(OWN_VOICE_LANGUAGES).not.toContain("ja");
  });
});

const SPEECH_LANGUAGE_CODES_RTL = () => Object.keys(SPEECH_LANGUAGES).filter((l) => isRightToLeft(l));

describe("the hashtags a video is posted with (phase 7 spec §18)", () => {
  it("are five, each a # and one run of letters, none generic and none twice, in the order sent", () => {
    expect(normalizeHashtags(["#history", "Roman Empire", "#history", "#FYP", "#roman_legions", "#300", "#ancientrome", "#caesar", "#extra"])).toEqual(["#history", "#RomanEmpire", "#roman_legions", "#ancientrome", "#caesar"]);
    expect(normalizeHashtags(["#Tarih!", "#keşfet", "#tarih", "#Osmanlı İmparatorluğu"])).toEqual(["#Tarih", "#Osmanlıİmparatorluğu"]);
  });

  it("keep the letters and marks of every script", () => {
    expect(normalizeHashtags(["#歴史", "#日本の歴史", "#تاريخ", "#इतिहास", "#역사"])).toEqual(["#歴史", "#日本の歴史", "#تاريخ", "#इतिहास", "#역사"]);
  });

  it("are asked for in the video's language and its own script, and put right rather than sent back", () => {
    const base = { topic: "t", aspect: "9:16", sceneCount: 3, voiceId: "narrator-m" } as const;
    expect(buildScriptPrompt({ ...base, language: "ja" })).toMatch(/hashtags: exactly 5[^\n]*in Japanese, in its own script/);
    const s = fakeScript(3);
    const checked = validateScript({ ...s, hashtags: ["fyp", "#wildlife", "wild life", "#Wildlife"] }, 3);
    expect(checked.ok && checked.script.hashtags).toEqual(["#wildlife"]);
  });
});
