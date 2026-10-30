import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { ffmpeg, probeDuration } from "../../src/media/ffmpeg.js";
import { type RunOptions, planRun, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { SOUND_NEGATIVE_PROMPT, SOUND_STEPS, soundSeconds } from "../../src/sound.js";
import { STAGES } from "../../src/stages/index.js";
import { soundStage } from "../../src/stages/sound.js";
import { sceneStagesShown } from "../../src/studio/status.js";
import { sceneFrames } from "../../src/stages/visual.js";
import type { ActionLevel } from "../../src/manifest/schema.js";
import { FakeSound } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 14 spec §3: every scene's sound is made from its picture after the fit, with a seed of its own, and levelled.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const RATES = { runpodFoleyUsdPerSec: 0.0003, runpodFoleySecPerClipSec: 4, runpodFoleyColdStartSec: 90 };
const LEVELS: ActionLevel[] = ["high", "low", "medium", "high"];

async function soundRun(opts: { sceneSound?: boolean; sfx?: boolean } = {}) {
  const made = await makeTestContext({ modes: [1, 1, 2, 1], shots: ["cut", "continue", "cut", "cut"], actionLevels: LEVELS, seed: 4242 });
  const sound = new FakeSound(join(made.dir, "_fakes"));
  made.ctx.providers = { ...made.ctx.providers, sound };
  Object.assign(made.ctx.prices, RATES);
  if (opts.sceneSound !== false) made.ctx.manifest.request.sceneSound = true;
  if (opts.sfx === false) made.ctx.manifest.request.render.sfx = false;
  made.ctx.manifest.models.sound = "runpod:fo1/sound-foley@1";
  return { ...made, sound };
}

async function loudness(path: string): Promise<number> {
  const log = await ffmpeg(["-i", path, "-af", "ebur128", "-f", "null", "-"], { logLevel: "info" });
  return Number(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(log)![1]);
}

async function hasAudio(path: string): Promise<boolean> {
  const r = await execa("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path]);
  return String(r.stdout).trim() !== "";
}

describe("a run made with scene sound", () => {
  it("buys one sound for every scene after the fit, each with its own prompt, seed, guidance and length", async () => {
    const { ctx, sound } = await soundRun();
    await runPipeline(ctx, STAGES, auto);
    const m = ctx.manifest;
    expect(sound.submits).toHaveLength(4);
    const seconds = sceneFrames(m, ctx.fps).map((f) => soundSeconds(f / ctx.fps));
    expect(sound.submits.map((r) => r.prompt)).toEqual(m.script!.scenes.map((s) => s.soundPrompt));
    expect(sound.submits.every((r) => r.negativePrompt === SOUND_NEGATIVE_PROMPT && r.steps === SOUND_STEPS)).toBe(true);
    expect(new Set(sound.submits.map((r) => r.seed)).size).toBe(4);
    expect(sound.submits.map((r) => r.guidanceScale)).toEqual([5.5, 3.5, 4.5, 5.5]);
    expect(sound.submits.map((r) => r.audioLengthSec)).toEqual(seconds);
    // a moving scene is heard from its fitted picture, after the fit
    expect(sound.submits[0].videoPath).toBe(join(ctx.dir, "sound/input_01.mp4"));
    for (const i of [0, 1, 3]) expect(m.scenes[i].stages.sound!.finishedAt >= m.scenes[i].stages.fit!.finishedAt).toBe(true);
    expect(STAGES.map((s) => s.name).slice(-4)).toEqual(["fit", "sound", "captions", "render"]);
    // what is kept, scene by scene
    expect(m.scenes[1].sound).toMatchObject({ path: "sound/scene_02.wav", seed: sound.submits[1].seed, guidance: 3.5, steps: 50, prompt: "wind and surf, scene 2" });
    expect(m.scenes[1].sound!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.ledger.filter((e) => e.stage === "sound").map((e) => e.scene)).toEqual([0, 1, 2, 3]);
    // and a resume buys nothing again
    expect((await planRun(ctx, STAGES)).items).toEqual([]);
    await runPipeline(ctx, STAGES, auto);
    expect(sound.submits).toHaveLength(4);
  });

  it("hears a still scene from a silent zoom over its picture, as long as the scene", async () => {
    const { ctx, sound } = await soundRun();
    await runPipeline(ctx, STAGES, auto);
    const input = join(ctx.dir, "sound/input_03.mp4");
    expect(sound.submits[2].videoPath).toBe(input);
    expect(existsSync(input)).toBe(true);
    expect(await hasAudio(input)).toBe(false);
    expect(await probeDuration(input)).toBeCloseTo(sound.submits[2].audioLengthSec, 1);
  });

  it("levels a loud and a quiet answer to within 1 dB of -26 LUFS", async () => {
    for (const db of [-3, -30]) {
      const { ctx, sound } = await soundRun();
      sound.levelDb = db;
      await runPipeline(ctx, STAGES, auto);
      for (const s of ctx.manifest.scenes) expect(Math.abs((await loudness(join(ctx.dir, s.sound!.path))) + 26)).toBeLessThan(1);
    }
  });

  it("counts the worker's start once, on the first scene", async () => {
    const { ctx } = await soundRun();
    await runPipeline(ctx, STAGES.slice(0, STAGES.findIndex((s) => s.name === "silence") + 1), auto);
    const costs = [0, 1, 2, 3].map((i) => soundStage.estimateCostUsd(ctx, i));
    expect(costs[0]).toBeGreaterThan(costs[1] + 0.02);
    expect(costs.slice(1).every((c) => c < 0.02)).toBe(true);
  });

  it("asks again for one scene only when that scene's sound is rerolled, with a new seed", async () => {
    const { ctx, sound } = await soundRun();
    await runPipeline(ctx, STAGES, auto);
    const before = sound.submits[1].seed;
    bumpNonce(ctx.manifest, 2, "sound");
    expect((await planRun(ctx, STAGES)).items.filter((i) => i.stage === "sound").map((i) => i.scene)).toEqual([1]);
    await runPipeline(ctx, STAGES, auto);
    expect(sound.submits).toHaveLength(5);
    expect(sound.submits[4].prompt).toBe("wind and surf, scene 2");
    expect(sound.submits[4].seed).not.toBe(before);
    expect(ctx.manifest.scenes[1].sound!.seed).toBe(sound.submits[4].seed);
  });

  it("keys a scene's sound on its model and its picture, and not on the level it is mixed at", async () => {
    const { ctx } = await soundRun();
    await runPipeline(ctx, STAGES, auto);
    const key = async () => JSON.stringify(await soundStage.inputsFor(ctx, 0));
    const first = await key();
    ctx.manifest.request.render.sfxGain = 0.1;
    expect(await key()).toBe(first);
    ctx.manifest.models.sound = "runpod:fo2/sound-foley@1";
    expect(await key()).not.toBe(first);
  });

  it("asks for at least 1 s for a scene shorter than that, and keeps a track no longer than the scene", async () => {
    const { ctx, sound } = await soundRun();
    await runPipeline(ctx, STAGES.slice(0, STAGES.findIndex((s) => s.name === "fit") + 1), auto);
    // (the still scene, so its picture does not have to be fitted again to the new length)
    ctx.manifest.scenes[2].audio!.duration = 0.8;
    const sceneSec = sceneFrames(ctx.manifest, ctx.fps)[2] / ctx.fps;
    expect(sceneSec).toBeLessThan(1);
    await runPipeline(ctx, [soundStage], auto);
    const asked = sound.submits.find((r) => r.videoPath.endsWith("input_03.mp4"))!;
    expect(asked.audioLengthSec).toBe(1);
    expect(await probeDuration(join(ctx.dir, ctx.manifest.scenes[2].sound!.path))).toBeCloseTo(sceneSec, 1);
    expect(ctx.manifest.scenes[2].sound!.seconds).toBeCloseTo(sceneSec, 2);
  });

  it("keys a scene's sound on whether its track is cut and faded at the model's limit", async () => {
    const { ctx } = await soundRun();
    await runPipeline(ctx, STAGES.slice(0, STAGES.findIndex((s) => s.name === "fit") + 1), auto);
    const keyAt = async (sec: number) => {
      ctx.manifest.scenes[2].audio!.duration = sec;
      return (await soundStage.inputsFor(ctx, 2)) as { audioLengthSec: number };
    };
    const under = await keyAt(9.97);
    const over = await keyAt(10.03);
    expect(under.audioLengthSec).toBe(over.audioLengthSec);
    expect(JSON.stringify(over)).not.toBe(JSON.stringify(under));
  });

  it("shows the sound step in the studio's list of a scene's steps", async () => {
    const { ctx } = await soundRun();
    await runPipeline(ctx, STAGES.slice(0, 2), auto);
    expect(sceneStagesShown(ctx.manifest, 0)).toContain("sound");
    expect(sceneStagesShown(ctx.manifest, 2)).toContain("sound");
  });
});

describe("a run that buys no scene sound", () => {
  it("is one made without it", async () => {
    const { ctx, sound } = await soundRun({ sceneSound: false });
    await runPipeline(ctx, STAGES, auto);
    expect(sound.submits).toEqual([]);
    expect(ctx.manifest.scenes.every((s) => s.sound === undefined)).toBe(true);
    expect(() => bumpNonce(ctx.manifest, 1, "sound")).toThrow(/no scene sound/);
    expect(sceneStagesShown(ctx.manifest, 0)).not.toContain("sound");
  });

  it("is one whose sound effects are off", async () => {
    const { ctx, sound } = await soundRun({ sfx: false });
    await runPipeline(ctx, STAGES, auto);
    expect(sound.submits).toEqual([]);
  });

  it("is one whose script wrote no sound prompts (a script written before them)", async () => {
    const { ctx, sound } = await soundRun();
    await runPipeline(ctx, STAGES.slice(0, 1), auto);
    for (const s of ctx.manifest.script!.scenes) delete s.soundPrompt;
    await runPipeline(ctx, STAGES, auto);
    expect(sound.submits).toEqual([]);
  });
});
