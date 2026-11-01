import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import type { Mode } from "../../src/manifest/schema.js";
import { ffmpeg, probeDuration } from "../../src/media/ffmpeg.js";
import { sceneFrameCounts } from "../../src/media/timeline.js";
import { planRun, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { captionsStage, globalWords } from "../../src/stages/captions.js";
import { clipsStage, MAX_SPOKEN_SEC, speakingClipSec, SPEECH_TAIL_SEC } from "../../src/stages/clips.js";
import { speakingFrames } from "../../src/video-profiles.js";
import { firstRendition } from "../../src/voice/words.js";
import { fitStage } from "../../src/stages/fit.js";
import { STAGES } from "../../src/stages/index.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { modesStage } from "../../src/stages/modes.js";
import { abs, paths } from "../../src/stages/paths.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { durationDep, isSpeaking, sceneFrames } from "../../src/stages/visual.js";
import { sceneStagesShown } from "../../src/studio/status.js";
import { ProviderJob } from "../../src/manifest/schema.js";
import { versionProblem } from "../../src/versions.js";
import type { ActionLevel } from "../../src/manifest/schema.js";
import { FakeLtxVideo, fakeScript, SPOKEN, type Shot } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";
import { draftEstimate } from "../../src/studio/draft.js";
import { planningCopy, planQuery, runDraft } from "../../src/studio/commands.js";

// Phase 15 spec §4, §5, §13.2–13.3: a scene in which a person speaks takes its sound, its length and its caption words
// from its clip; every other scene is made as it always was.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const LTX_PRICES = { runpodLtxUsdPerSec: 0.0011, runpodLtxSecPerClipSec: 30, runpodLtxColdStartSec: 120 };
const SENTENCE = "Hello there friend";
const AUDIO = [scriptStage, ttsStage, silenceStage];
const MEDIA = [scriptStage, ttsStage, silenceStage, modesStage, keyframesStage, clipsStage, fitStage, captionsStage];

type Options = { speaking?: number[]; allow?: boolean; shots?: Shot[]; modes?: Mode[] | "auto"; actionLevels?: ActionLevel[] };

/** An LTX run of three scenes in English, whose script gives the scenes in `speaking` the sentence (as narration too). */
async function speechRun(opts: Options = {}) {
  const speaking = opts.speaking ?? [1];
  const shots = opts.shots ?? ["cut", "cut", "continue"];
  const levels = opts.actionLevels ?? ["high", "high", "high"];
  const script = () => {
    const s = fakeScript(3, { shots, actionLevels: levels });
    for (const i of speaking) Object.assign(s.scenes[i], { speech: SENTENCE, narration: SENTENCE });
    return s;
  };
  const made = await makeTestContext({ modes: opts.modes ?? [1, 1, 1], shots, actionLevels: levels, script: () => script(), seed: 7 });
  const ltx = new FakeLtxVideo(`${made.dir}/_fakes`);
  made.ctx.providers = { ...made.ctx.providers, video: ltx };
  made.ctx.prices = Prices.parse(LTX_PRICES);
  const m = made.ctx.manifest;
  m.request.videoProfile = "ltx25@1";
  m.request.language = "en";
  if (m.request.modePrices) m.request.modePrices = Prices.parse(LTX_PRICES);
  m.models.video = "runpod:ep-l/clip-ltx25@1";
  if (opts.allow !== false) Object.assign(m.request, { speech: true, speakingClip: "sentence" });
  return { ...made, ltx };
}

const frame = 1 / 30;

/** The loudest sound of `len` seconds of a file from `from`, in dBFS (-91 for digital silence). */
async function maxDb(file: string, from: number, len: number): Promise<number> {
  const log = await ffmpeg(["-ss", String(from), "-t", String(len), "-i", file, "-af", "volumedetect", "-f", "null", "-"], { logLevel: "info" });
  return Number(/max_volume: (-?[\d.]+) dB/.exec(log)![1]);
}

describe("which scene speaks", () => {
  it("is a scene with a sentence in a run that allows speech, and no other", async () => {
    const { ctx } = await speechRun();
    await runPipeline(ctx, [scriptStage], auto);
    const m = ctx.manifest;
    expect([0, 1, 2].map((i) => isSpeaking(m, i))).toEqual([false, true, false]);
    // a sentence of only spaces says nothing
    m.script!.scenes[1].speech = "   ";
    expect(isSpeaking(m, 1)).toBe(false);
    // and a sentence in a run that did not allow speech buys nothing
    m.script!.scenes[1].speech = SENTENCE;
    delete m.request.speech;
    expect(isSpeaking(m, 1)).toBe(false);
    // nor in a run whose clips are made by an engine that does not speak
    m.request.speech = true;
    m.request.videoProfile = "wan22-480p@1";
    expect(isSpeaking(m, 1)).toBe(false);
  });

  it("takes an ordinary scene's length from its trimmed voiceover and a speaking scene's from its clip", async () => {
    const { ctx } = await speechRun();
    await runPipeline(ctx, [scriptStage], auto);
    expect(durationDep(ctx.manifest, 0)).toEqual({ stage: "silence", scene: 0 });
    expect(durationDep(ctx.manifest, 1)).toEqual({ stage: "clips", scene: 1 });
    delete ctx.manifest.request.speech;
    expect(durationDep(ctx.manifest, 1)).toEqual({ stage: "silence", scene: 1 });
  });
});

describe("a speaking scene's voice", () => {
  it("is not bought or trimmed by tts and silence, which still run for every other scene", async () => {
    const { ctx, fakes } = await speechRun();
    await runPipeline(ctx, AUDIO, auto);
    const m = ctx.manifest;
    expect(fakes.tts.calls.map((c) => c.text)).toEqual([m.script!.scenes[0].narration, m.script!.scenes[2].narration]);
    expect(m.scenes[1].tts).toBeUndefined();
    expect(m.scenes[1].audio).toBeUndefined();
    expect(m.scenes[1].stages.tts).toBeUndefined();
    expect(m.scenes[1].stages.silence).toBeUndefined();
    expect([0, 2].map((i) => m.scenes[i].stages.silence?.status)).toEqual(["done", "done"]);
    // and the studio does not show them as steps the scene still waits for
    expect(sceneStagesShown(m, 1)).not.toContain("tts");
    expect(sceneStagesShown(m, 1)).not.toContain("silence");
    expect(sceneStagesShown(m, 0)).toContain("tts");
  });

  it("is in no tts or silence step of a run without speech, even where the script wrote a sentence", async () => {
    const { ctx, fakes } = await speechRun({ allow: false });
    await runPipeline(ctx, [scriptStage], auto);
    // (a stray sentence is cleared by the script stage; put one back to see the stages ignore it as well)
    ctx.manifest.script!.scenes[1].speech = SENTENCE;
    await runPipeline(ctx, [ttsStage, silenceStage], auto);
    expect(fakes.tts.calls).toHaveLength(3);
  });
});

describe("a speaking scene's clip", () => {
  it("is asked for with the video's language and the scene's own prompt, at a length worked out from its sentence", async () => {
    const { ctx, ltx } = await speechRun();
    await runPipeline(ctx, MEDIA, auto);
    const asked = ltx.submits;
    expect(asked.map((r) => r.speechLanguage)).toEqual([undefined, "en", undefined]);
    expect(asked[1].prompt).toBe(ctx.manifest.script!.scenes[1].videoPrompt);
    // three words: the shortest speaking clip, 97 frames
    expect(asked[1].durationSec).toBe(97 / 24);
    expect(speakingClipSec(ctx.manifest, 1)).toBe(97 / 24);
  });

  it("is asked for at the longest, 169 frames, in a run frozen before clip lengths came from the sentence", async () => {
    const { ctx, ltx } = await speechRun();
    delete ctx.manifest.request.speakingClip;
    await runPipeline(ctx, MEDIA, auto);
    expect(ltx.submits[1].durationSec).toBe(169 / 24);
  });

  it("gives the scene the clip's own sound, cut only 0.4 s after its last word, and the worker's words at the worker's times", async () => {
    const { ctx } = await speechRun();
    await runPipeline(ctx, MEDIA, auto);
    const audio = ctx.manifest.scenes[1].audio!;
    expect(audio.path).toBe(paths.audio(1));
    expect(existsSync(abs(ctx, paths.clipAudio(1)))).toBe(true);
    const whole = await probeDuration(abs(ctx, paths.clipAudio(1)));
    // the last word ends at 2.55 s of the clip; nothing before it is removed
    expect(Math.abs(audio.duration - (2.55 + SPEECH_TAIL_SEC))).toBeLessThanOrEqual(frame);
    expect(Math.abs(audio.duration - (whole - audio.removedSec))).toBeLessThanOrEqual(frame);
    expect(Math.abs(audio.duration - (await probeDuration(abs(ctx, audio.path))))).toBeLessThanOrEqual(0.001);
    expect(audio.words).toEqual(SPOKEN.words);
  });

  it("keeps the clip's silence before the first word, so the voice starts where the lips do", async () => {
    const { ctx } = await speechRun();
    await runPipeline(ctx, MEDIA, auto);
    const audio = abs(ctx, ctx.manifest.scenes[1].audio!.path);
    // the speech starts 0.6 s into the clip (its first word at 0.62 s): the scene's audio is silent until then too
    expect(await maxDb(audio, 0, 0.52)).toBeLessThan(-80);
    expect(await maxDb(audio, 0.65, 0.5)).toBeGreaterThan(-20);
    expect(await maxDb(abs(ctx, paths.clipAudio(1)), 0, 0.52)).toBeLessThan(-80);
  });

  it("keeps a long pause inside the sentence", async () => {
    const { ctx, ltx } = await speechRun();
    ltx.speech = {
      audio: [{ silence: 0.3 }, { tone: 1 }, { silence: 0.8 }, { tone: 1 }],
      words: [{ text: "Wait", start: 0.32, end: 1.25 }, { text: "now", start: 2.12, end: 3.05 }],
    };
    await runPipeline(ctx, MEDIA, auto);
    const audio = ctx.manifest.scenes[1].audio!;
    expect(Math.abs(audio.duration - (3.05 + SPEECH_TAIL_SEC))).toBeLessThanOrEqual(frame);
    expect(audio.words).toEqual(ltx.speech.words);
    expect(await maxDb(abs(ctx, audio.path), 1.4, 0.6)).toBeLessThan(-80);
    expect(await maxDb(abs(ctx, audio.path), 2.2, 0.5)).toBeGreaterThan(-20);
  });

  it("places the next scene after the speaking scene's cut length, in the frames and in the captions", async () => {
    const { ctx } = await speechRun();
    await runPipeline(ctx, MEDIA, auto);
    const m = ctx.manifest;
    const d = m.scenes.map((s) => s.audio!.duration);
    expect(sceneFrames(m, ctx.fps)).toEqual(sceneFrameCounts(d, ctx.fps));
    expect(m.scenes.map((s) => s.fitted!.frames)).toEqual(sceneFrameCounts(d, ctx.fps));
    const text = await readFile(abs(ctx, paths.captions), "utf8");
    // the speaking scene's captions are the words heard in its clip, from the end of scene 1
    for (const w of ["Hello", "there", "friend"]) expect(text).toContain(w);
    expect(m.scenes[1].audio!.words[0].text).toBe("Hello");
    const firstOfThird = m.scenes[2].audio!.words[0].start + d[0] + d[1];
    const firstOfSpeech = m.scenes[1].audio!.words[0].start + d[0];
    const all = globalWords(m);
    expect(all.find((w) => w.text === "Hello")!.start).toBeCloseTo(firstOfSpeech, 6);
    const third = all.slice(m.scenes[0].audio!.words.length + 3);
    expect(third[0].start).toBeCloseTo(firstOfThird, 6);
    expect(third[0].start).toBeGreaterThanOrEqual(d[0] + d[1]);
  });

  it("carries the next scene on from the speaking clip at the speaking scene's own length", async () => {
    const { ctx, ltx } = await speechRun({ shots: ["cut", "cut", "continue"] });
    await runPipeline(ctx, MEDIA, auto);
    const m = ctx.manifest;
    expect(ltx.submits).toHaveLength(3);
    const inputs = (await clipsStage.inputsFor(ctx, 2)) as { seam: { prevFrames: number } };
    expect(inputs.seam.prevFrames).toBe(sceneFrameCounts(m.scenes.map((s) => s.audio!.duration), ctx.fps)[1]);
  });

  it("does not hold up a scene before it, whose clip carries on without the speaking scene's length", async () => {
    const { ctx, ltx } = await speechRun({ speaking: [2], shots: ["cut", "continue", "cut"] });
    await runPipeline(ctx, MEDIA, auto);
    expect(ltx.submits.map((r) => r.speechLanguage)).toEqual([undefined, undefined, "en"]);
    expect(ctx.manifest.scenes[2].audio!.words.map((w) => w.text)).toEqual(["Hello", "there", "friend"]);
  });

  it("is made before any later scene that needs its length, and a finished run plans nothing again", async () => {
    const { ctx } = await speechRun({ speaking: [0], shots: ["cut", "continue", "continue"] });
    const fresh = await planRun(ctx, STAGES);
    await runPipeline(ctx, STAGES, auto);
    const m = ctx.manifest;
    expect(m.final).toBeDefined();
    expect(m.scenes[0].stages.tts).toBeUndefined();
    expect(m.scenes[0].stages.clips!.finishedAt <= m.scenes[1].stages.clips!.finishedAt).toBe(true);
    expect((await planRun(ctx, STAGES)).items).toEqual([]);
    expect(fresh.items.some((i) => i.stage === "clips" && i.scene === 0)).toBe(true);
  });
});

describe("a speaking clip's length", () => {
  it("is about the sentence's time and a second more, as 8k+1 frames between 97 and 169", () => {
    expect([1, 3, 6, 9, 12, 14, 18, 30].map((w) => speakingFrames(w))).toEqual([97, 97, 97, 97, 121, 137, 169, 169]);
    for (const w of [1, 9, 12, 14, 18]) expect((speakingFrames(w) - 1) % 8).toBe(0);
    // where only the cap is known, the longest
    expect(speakingFrames()).toBe(169);
  });
});

/** A sentence said, then said again without its third word, as LTX did on a real run (2026-11-01). */
const TWICE = (() => {
  const said = "Stop adding olive oil to your boiling water, because sauce will slide right off.".split(" ");
  const first = said.map((text, i) => ({ text, start: i * 0.29, end: i * 0.29 + 0.25 }));
  const again = said.filter((_, i) => i !== 6).map((text, i) => ({ text, start: 4.2 + i * 0.21, end: 4.2 + i * 0.21 + 0.18 }));
  return [...first, ...again];
})();

describe("a sentence the clip said twice", () => {
  it("is kept once: the words up to where its first two words come again", () => {
    expect(firstRendition(TWICE).map((w) => w.text)).toEqual("Stop adding olive oil to your boiling water, because sauce will slide right off.".split(" "));
    const at = (texts: string[]) => texts.map((text, i) => ({ text, start: i, end: i + 0.5 }));
    // repeated at the middle
    expect(firstRendition(at(["Look", "up", "now", "look", "up", "now"])).map((w) => w.text)).toEqual(["Look", "up", "now"]);
  });

  it("is left whole when nothing is said again, or when a sentence repeats its own first words", () => {
    const at = (texts: string[]) => texts.map((text, i) => ({ text, start: i, end: i + 0.5 }));
    const once = at(["Stop", "adding", "oil", "to", "the", "water"]);
    expect(firstRendition(once)).toEqual(once);
    const stop = at(["Stop,", "stop,", "stop", "the", "car"]);
    expect(firstRendition(stop)).toEqual(stop);
    // a first word heard again with another after it is no repeat
    const again = at(["Wait", "here", "and", "wait", "there"]);
    expect(firstRendition(again)).toEqual(again);
  });

  it("gives the scene only the first saying, in its captions and in its sound", async () => {
    const { ctx, ltx } = await speechRun();
    ltx.speech = {
      audio: [{ silence: 0.2 }, { tone: 1.8 }, { silence: 0.3 }, { tone: 1.6 }],
      words: [
        { text: "Hello", start: 0.2, end: 0.7 }, { text: "there", start: 0.75, end: 1.3 }, { text: "friend.", start: 1.35, end: 1.95 },
        { text: "Hello", start: 2.3, end: 2.8 }, { text: "there", start: 2.85, end: 3.4 },
      ],
    };
    await runPipeline(ctx, MEDIA, auto);
    const audio = ctx.manifest.scenes[1].audio!;
    expect(audio.words.map((w) => w.text)).toEqual(["Hello", "there", "friend."]);
    expect(Math.abs(audio.duration - (1.95 + SPEECH_TAIL_SEC))).toBeLessThanOrEqual(frame);
    expect(await readFile(abs(ctx, paths.captions), "utf8")).not.toMatch(/Hello[\s\S]*Hello/);
  });

  it("is cut on resume from the job's kept answer, without buying the clip again", async () => {
    const { ctx, ltx } = await speechRun();
    ltx.speech = { audio: [{ silence: 0.2 }, { tone: 1.8 }, { silence: 0.3 }, { tone: 1.6 }], words: [
      { text: "Hello", start: 0.2, end: 0.7 }, { text: "there", start: 0.75, end: 1.3 }, { text: "friend.", start: 1.35, end: 1.95 },
      { text: "Hello", start: 2.3, end: 2.8 }, { text: "there", start: 2.85, end: 3.4 },
    ] };
    // stopped after the job was paid for: its answer, the repeat in it, is kept
    ltx.withhold = (req) => req.speechLanguage !== undefined;
    await expect(runPipeline(ctx, MEDIA, auto)).rejects.toThrow();
    expect(ctx.manifest.scenes[1].jobs.clips!.result!.words).toHaveLength(5);
    await ltx.release();
    await runPipeline(ctx, MEDIA, auto);
    expect(ltx.submits.filter((r) => r.speechLanguage !== undefined)).toHaveLength(1);
    expect(ctx.manifest.scenes[1].audio!.words.map((w) => w.text)).toEqual(["Hello", "there", "friend."]);
  });
});

describe("a speaking scene's paid clip", () => {
  it("is finished on resume from what its job answered, without buying it again, when its download failed", async () => {
    const { ctx, ltx } = await speechRun();
    ltx.withhold = (req) => req.speechLanguage !== undefined;
    await expect(runPipeline(ctx, MEDIA, auto)).rejects.toThrow();
    expect(ctx.manifest.scenes[1].jobs.clips!.result).toMatchObject({ fps: 24, hasAudio: true, words: SPOKEN.words });
    await ltx.release();
    await runPipeline(ctx, MEDIA, auto);
    expect(ltx.submits.filter((r) => r.speechLanguage !== undefined)).toHaveLength(1);
    expect(ctx.manifest.scenes[1].audio!.words).toEqual(SPOKEN.words);
    expect(ctx.manifest.ledger.filter((e) => e.stage === "clips" && e.scene === 1)).toHaveLength(1);
  });

  it("is kept in a record that still loads as it was written before, and refuses words a caption could not be placed by", () => {
    expect(ProviderJob.parse({ requestId: "r", inputHash: "h", submittedAt: "t", result: { url: "u" } }).result).toEqual({ url: "u" });
    const kept = { url: "u", fps: 24, hasAudio: true, words: [{ text: "Hi", start: 0.1, end: 0.4 }] };
    expect(ProviderJob.parse({ requestId: "r", inputHash: "h", submittedAt: "t", result: kept }).result).toEqual(kept);
    for (const word of [{ text: "Hi", start: -0.1, end: 0.4 }, { text: "Hi", start: 0.5, end: 0.4 }, { text: "Hi", start: Number.NaN, end: 0.4 }]) {
      expect(ProviderJob.safeParse({ requestId: "r", inputHash: "h", submittedAt: "t", result: { url: "u", words: [word] } }).success).toBe(false);
    }
  });
});

describe("a version of a video with a speaking scene", () => {
  it("is refused before anything is bought, saying why without naming an engine", async () => {
    const { ctx } = await speechRun();
    await runPipeline(ctx, [scriptStage], auto);
    const problem = versionProblem(ctx.manifest, "de");
    expect(problem).toBe("a video with a speaking character cannot be made in another language: its character speaks the source language");
    expect(problem).not.toMatch(/ltx|lightricks|runpod|whisper/i);
  });

  it("is not refused for that in a run that allows speech and has no speaking scene", async () => {
    const { ctx } = await speechRun({ speaking: [] });
    await runPipeline(ctx, [scriptStage], auto);
    expect(versionProblem(ctx.manifest, "de") ?? "").not.toMatch(/speaking character/);
  });
});

describe("a speaking scene that cannot be used", () => {
  it("fails, naming the scene, when the sentence with its tail is longer than it may be, and keeps the clip's charge", async () => {
    const { ctx, ltx } = await speechRun();
    // (only a clip of the longest length can hold that much: a run frozen before lengths came from the sentence)
    delete ctx.manifest.request.speakingClip;
    ltx.speech = { audio: [{ silence: 0.1 }, { tone: MAX_SPOKEN_SEC + 0.3 }], words: [{ text: "far", start: 0.2, end: 6.7 }] };
    await expect(runPipeline(ctx, MEDIA, auto)).rejects.toThrow("scene 2's sentence does not fit; the script wrote too many words");
    expect(ltx.submits).toHaveLength(2);
    expect(ctx.manifest.ledger.filter((e) => e.stage === "clips" && e.scene === 1)).toHaveLength(1);
    expect(ctx.manifest.scenes[1].stages.clips?.status).toBe("failed");
  });

  it("fails, naming the scene, when the clip came back without its words, and guesses none", async () => {
    const { ctx, ltx } = await speechRun();
    ltx.speech = { ...SPOKEN, words: undefined };
    await expect(runPipeline(ctx, MEDIA, auto)).rejects.toThrow("scene 2: this scene's clip came back without its speech words; make the scene's clip again");
    expect(ctx.manifest.scenes[1].audio).toBeUndefined();
  });

  it("fails, naming the scene, when nothing was heard in the clip", async () => {
    const { ctx, ltx } = await speechRun();
    ltx.speech = { ...SPOKEN, words: [] };
    await expect(runPipeline(ctx, MEDIA, auto)).rejects.toThrow(/^scene 2: /);
    expect(ctx.manifest.scenes[1].audio).toBeUndefined();
  });

  it("fails, naming the scene, when the clip has no sound", async () => {
    const { ctx, ltx } = await speechRun();
    ltx.silent = true;
    await expect(runPipeline(ctx, MEDIA, auto)).rejects.toThrow(/^scene 2: .*no sound/);
    expect(ctx.manifest.scenes[1].audio).toBeUndefined();
  });

  it("names no model or provider in what it says", async () => {
    const { ctx, ltx } = await speechRun();
    ltx.speech = { ...SPOKEN, words: undefined };
    const error = await runPipeline(ctx, MEDIA, auto).catch((e: Error) => e);
    expect(String(error)).not.toMatch(/ltx|lightricks|runpod|whisper/i);
  });
});

describe("a speaking scene's mode", () => {
  it("is Mode 1 even where the rules would make it a still", async () => {
    const { ctx } = await speechRun({ modes: "auto", actionLevels: ["high", "low", "low"] });
    await runPipeline(ctx, [...AUDIO, modesStage], auto);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([1, 1, 2]);
    expect(ctx.manifest.scenes[1].modeReason).toBe("a person speaks in it");
  });

  it("is Mode 1 even where the user pinned a still", async () => {
    const { ctx } = await speechRun({ modes: "auto", actionLevels: ["high", "high", "high"] });
    ctx.manifest.request.modeOverrides = [null, 2, 2];
    await runPipeline(ctx, [...AUDIO, modesStage], auto);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([1, 1, 2]);
  });

  it("is Mode 1 even where the run's modes were given and said otherwise", async () => {
    const { ctx } = await speechRun({ modes: [1, 2, 2] });
    await runPipeline(ctx, [...AUDIO, modesStage], auto);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([1, 1, 2]);
  });

  it("adds no voiceover to what the modes are priced at", async () => {
    const { ctx } = await speechRun({ modes: "auto" });
    await runPipeline(ctx, AUDIO, auto);
    const { auto: inputs } = (await modesStage.inputsFor(ctx)) as { auto: { scenes: Array<{ narrationChars: number; requestedSec: number }> } };
    // and its clip at the length its sentence asks for (three words: 97 frames), as a draft's price is
    expect(inputs.scenes[1].requestedSec).toBe(97 / 24);
    expect(inputs.scenes.map((s) => s.narrationChars)).toEqual([ctx.manifest.script!.scenes[0].narration.length, 0, ctx.manifest.script!.scenes[2].narration.length]);
  });

  it("leaves a run without a speaking scene's mode key as it was", async () => {
    const { ctx } = await speechRun({ speaking: [], modes: "auto" });
    await runPipeline(ctx, [...AUDIO, modesStage], auto);
    expect(JSON.stringify(await modesStage.inputsFor(ctx))).not.toContain("speak");
    expect(modesStage.deps(ctx.manifest)).toEqual([{ stage: "script" }, ...[0, 1, 2].map((scene) => ({ stage: "silence", scene }))]);
  });
});

describe("a draft with a speaking scene", () => {
  const round4 = (usd: number) => Math.round(usd * 10_000) / 10_000;

  it("is priced at the clip it buys, so the total approved for it covers what generating it plans, under the cap", async () => {
    // the rules would make every low-action scene a still and voice the speaking one: the modes stage then forces its clip
    const { ctx } = await speechRun({ modes: "auto", shots: ["cut", "cut", "cut"], actionLevels: ["low", "low", "low"] });
    ctx.manifest.request.modeBudgetUsd = 100;
    await runDraft(ctx, auto);
    expect(ctx.manifest.scenes[1].mode).toBe(1);
    const plan = draftEstimate(ctx.manifest, ctx.keyframeSize);
    expect(plan.modes[1]).toBe(1);
    const approved = (await planQuery({ ...ctx, manifest: planningCopy(ctx.manifest) }, STAGES)).totalUsd;
    // what generate's "Media plan" checkpoint compares with --cap: spent since the draft plus what is still planned
    const spentAtStart = ctx.manifest.ledger.reduce((sum, e) => sum + e.usd, 0);
    await runPipeline(ctx, [...AUDIO, modesStage], auto);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual(plan.modes);
    const spent = round4(ctx.manifest.ledger.reduce((sum, e) => sum + e.usd, 0) - spentAtStart);
    const media = await planRun(ctx, STAGES);
    expect(round4(spent + media.totalUsd)).toBeLessThanOrEqual(approved);
  });
});
