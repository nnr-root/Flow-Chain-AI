import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import type { Mode } from "../../src/manifest/schema.js";
import { probeDuration } from "../../src/media/ffmpeg.js";
import { sceneFrameCounts } from "../../src/media/timeline.js";
import { planRun, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { captionsStage, globalWords } from "../../src/stages/captions.js";
import { clipsStage, MAX_SPOKEN_SEC, SPEAKING_CLIP_SEC } from "../../src/stages/clips.js";
import { fitStage } from "../../src/stages/fit.js";
import { STAGES } from "../../src/stages/index.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { modesStage } from "../../src/stages/modes.js";
import { abs, paths } from "../../src/stages/paths.js";
import { scriptStage } from "../../src/stages/script.js";
import { SILENCE_PARAMS, silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { durationDep, isSpeaking, sceneFrames } from "../../src/stages/visual.js";
import { sceneStagesShown } from "../../src/studio/status.js";
import type { ActionLevel } from "../../src/manifest/schema.js";
import { FakeLtxVideo, fakeScript, SPOKEN, type Shot } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

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
  if (opts.allow !== false) m.request.speech = true;
  return { ...made, ltx };
}

const frame = 1 / 30;

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
  it("is asked for with the video's language and the scene's own prompt, at a length that holds the longest sentence", async () => {
    const { ctx, ltx } = await speechRun();
    await runPipeline(ctx, MEDIA, auto);
    const asked = ltx.submits;
    expect(asked.map((r) => r.speechLanguage)).toEqual([undefined, "en", undefined]);
    expect(asked[1].prompt).toBe(ctx.manifest.script!.scenes[1].videoPrompt);
    expect(asked[1].durationSec).toBe(SPEAKING_CLIP_SEC);
    expect(Math.round(SPEAKING_CLIP_SEC * 24) % 8).toBe(1);
    expect(SPEAKING_CLIP_SEC).toBeGreaterThan(MAX_SPOKEN_SEC);
  });

  it("gives the scene the clip's sound with its silence trimmed, as long as that sound, and the worker's words on it", async () => {
    const { ctx } = await speechRun();
    await runPipeline(ctx, MEDIA, auto);
    const audio = ctx.manifest.scenes[1].audio!;
    expect(audio.path).toBe(paths.audio(1));
    expect(existsSync(abs(ctx, paths.clipAudio(1)))).toBe(true);
    const whole = await probeDuration(abs(ctx, paths.clipAudio(1)));
    expect(Math.abs(audio.duration - (whole - audio.removedSec))).toBeLessThanOrEqual(frame);
    // 2 s of speech, with the padding the run's trimming keeps at either end
    expect(Math.abs(audio.duration - (2 + 2 * SILENCE_PARAMS.padding))).toBeLessThanOrEqual(frame);
    expect(Math.abs(audio.duration - (await probeDuration(abs(ctx, audio.path))))).toBeLessThanOrEqual(0.001);
    // the worker's words, moved by the 0.6 s of silence taken from the front
    expect(audio.words.map((w) => w.text)).toEqual(["Hello", "there", "friend"]);
    const cut = 0.6 - SILENCE_PARAMS.padding;
    audio.words.forEach((w, i) => {
      expect(w.start).toBeCloseTo(SPOKEN.words![i].start - cut, 2);
      expect(w.end).toBeCloseTo(SPOKEN.words![i].end - cut, 2);
    });
  });

  it("places the next scene after the speaking scene's trimmed length, in the frames and in the captions", async () => {
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

describe("a speaking scene that cannot be used", () => {
  it("fails, naming the scene, when the trimmed sentence is longer than it may be, and keeps the clip's charge", async () => {
    const { ctx, ltx } = await speechRun();
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

  it("leaves a run without a speaking scene's mode key as it was", async () => {
    const { ctx } = await speechRun({ speaking: [], modes: "auto" });
    await runPipeline(ctx, [...AUDIO, modesStage], auto);
    expect(JSON.stringify(await modesStage.inputsFor(ctx))).not.toContain("speak");
    expect(modesStage.deps(ctx.manifest)).toEqual([{ stage: "script" }, ...[0, 1, 2].map((scene) => ({ stage: "silence", scene }))]);
  });
});
