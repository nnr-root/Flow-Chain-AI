import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { fileSha256 } from "../../src/manifest/hash.js";
import { ffmpeg, probeDuration } from "../../src/media/ffmpeg.js";
import { planRun, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { guidanceFor, LOUDNESS_TARGET_LUFS, SCENE_SOUND_MAX_SEC, SOUND_NEGATIVE_PROMPT, SOUND_STEPS, soundAskSeconds, soundSeed } from "../../src/sound.js";
import { buildRenderProps } from "../../src/stages/build-render-props.js";
import { clipsStage } from "../../src/stages/clips.js";
import { fitStage } from "../../src/stages/fit.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { abs, paths } from "../../src/stages/paths.js";
import { renderStage } from "../../src/stages/render.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { soundStage } from "../../src/stages/sound.js";
import { ttsStage } from "../../src/stages/tts.js";
import { sceneFrames } from "../../src/stages/visual.js";
import { sceneStagesShown } from "../../src/studio/status.js";
import { FakeLtxVideo, FakeSound, fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 15 spec §6: an LTX clip's own sound is a scene's sound, as a Foley sound is, made for nothing from the clip; a
// speaking scene's sound is its voice and nothing more; Foley, where a run has it, wins. §9.4: nothing strips what a clip carries.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const LTX_PRICES = { runpodLtxUsdPerSec: 0.0011, runpodLtxSecPerClipSec: 30, runpodLtxColdStartSec: 120 };
const FOLEY_RATES = { runpodFoleyUsdPerSec: 0.0003, runpodFoleySecPerClipSec: 4, runpodFoleyColdStartSec: 90 };
const MEDIA = [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage, fitStage, soundStage];

/** An LTX run of three moving scenes; `speaking` scenes say a sentence (a run that allows speech, in English). */
async function ltxRun(opts: { speaking?: number[]; wan?: boolean } = {}) {
  const speaking = opts.speaking ?? [];
  const shots = ["cut", "continue", "cut"] as const;
  const script = () => {
    const s = fakeScript(3, { shots: [...shots] });
    for (const i of speaking) Object.assign(s.scenes[i], { speech: "Hello there friend", narration: "Hello there friend" });
    return s;
  };
  const made = await makeTestContext({ modes: [1, 1, 1], shots: [...shots], script, seed: 7 });
  const ltx = new FakeLtxVideo(`${made.dir}/_fakes`);
  const m = made.ctx.manifest;
  if (!opts.wan) {
    made.ctx.providers = { ...made.ctx.providers, video: ltx };
    made.ctx.prices = Prices.parse(LTX_PRICES);
    m.request.videoProfile = "ltx25@1";
    m.models.video = "runpod:ep-l/clip-ltx25@1";
  }
  m.request.language = "en";
  if (speaking.length) m.request.speech = true;
  return { ...made, ltx };
}

async function loudness(path: string): Promise<number> {
  const log = await ffmpeg(["-i", path, "-af", "ebur128", "-f", "null", "-"], { logLevel: "info" });
  return Number(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(log)![1]);
}

const sceneSec = (ctx: Awaited<ReturnType<typeof ltxRun>>["ctx"], i: number) => sceneFrames(ctx.manifest, ctx.fps)[i] / ctx.fps;

const props = (ctx: Awaited<ReturnType<typeof ltxRun>>["ctx"]) =>
  buildRenderProps(ctx.manifest, { dir: ctx.dir, fontsDir: resolve("assets/fonts"), fps: ctx.fps, size: ctx.size }, []).props;

describe("a scene's own clip sound", () => {
  it("is laid under an ordinary LTX scene as its sound, never longer than the scene and levelled to the scene-sound loudness, for nothing", async () => {
    const { ctx } = await ltxRun();
    await runPipeline(ctx, MEDIA.slice(0, -1), auto);
    // planned, and free: no Foley price is needed, nothing is bought
    const planned = (await planRun(ctx, MEDIA)).items.filter((i) => i.stage === "sound");
    expect(planned.map((i) => [i.scene, i.costUsd])).toEqual([[0, 0], [1, 0], [2, 0]]);
    await runPipeline(ctx, MEDIA, auto);
    const m = ctx.manifest;
    for (const i of [0, 1, 2]) {
      const sound = m.scenes[i].sound!;
      expect(sound).toEqual({ path: paths.sound(i), sha256: await fileSha256(abs(ctx, paths.sound(i))), seconds: sound.seconds, source: "clip" });
      // (an LTX clip is asked for a little shorter than its scene and slowed to fit: its sound is as long as it is)
      const heard = Math.min(sceneSec(ctx, i), m.scenes[i].clip!.duration);
      expect(sound.seconds).toBeCloseTo(heard, 1);
      expect(await probeDuration(abs(ctx, sound.path))).toBeCloseTo(heard, 1);
      expect(Math.abs((await loudness(abs(ctx, sound.path))) - LOUDNESS_TARGET_LUFS)).toBeLessThan(1);
      expect(m.scenes[i].stages.sound).toMatchObject({ status: "done", costUsd: 0 });
    }
    expect(m.ledger.filter((e) => e.stage === "sound")).toEqual([]);
    // the render lays each one down as it lays down a Foley sound
    expect(props(ctx).audio.sound.map((s) => s.src)).toEqual([0, 1, 2].map((i) => paths.sound(i)));
    // and a resume makes nothing again
    expect((await planRun(ctx, MEDIA)).items).toEqual([]);
  });

  it("is made though sound effects are off, and is not played until they are on", async () => {
    const { ctx } = await ltxRun();
    ctx.manifest.request.render.sfx = false;
    await runPipeline(ctx, MEDIA, auto);
    expect(ctx.manifest.scenes.every((s) => s.sound?.source === "clip")).toBe(true);
    expect(props(ctx).audio.sound).toEqual([]);
    // (a re-render that turns them on finds nothing to make: the render alone runs)
    ctx.manifest.request.render.sfx = true;
    expect((await planRun(ctx, MEDIA)).items).toEqual([]);
    expect(props(ctx).audio.sound).toHaveLength(3);
  });

  it("is never added to a speaking scene, whose voice already is its audio", async () => {
    const { ctx } = await ltxRun({ speaking: [1] });
    await runPipeline(ctx, MEDIA, auto);
    const m = ctx.manifest;
    expect(m.scenes[1].audio!.path).toBe(paths.audio(1));
    expect(m.scenes[1].sound).toBeUndefined();
    expect(m.scenes[1].stages.sound).toBeUndefined();
    expect(sceneStagesShown(m, 1)).not.toContain("sound");
    expect(sceneStagesShown(m, 0)).toContain("sound");
    expect(props(ctx).audio.sound.map((s) => s.src)).toEqual([paths.sound(0), paths.sound(2)]);
    expect(renderStage.deps(m).filter((d) => d.stage === "sound").map((d) => d.scene)).toEqual([0, 2]);
  });

  it("gives way to a Foley sound in a run made with scene sound", async () => {
    const { ctx } = await ltxRun();
    const foley = new FakeSound(join(ctx.dir, "_fakes"));
    ctx.providers = { ...ctx.providers, sound: foley };
    Object.assign(ctx.prices, FOLEY_RATES);
    ctx.manifest.request.sceneSound = true;
    ctx.manifest.models.sound = "runpod:fo1/sound-foley@1";
    await runPipeline(ctx, MEDIA, auto);
    expect(foley.submits).toHaveLength(3);
    for (const s of ctx.manifest.scenes) {
      expect(s.sound).toMatchObject({ steps: SOUND_STEPS });
      expect(s.sound!.source).toBeUndefined();
    }
    expect(ctx.manifest.ledger.filter((e) => e.stage === "sound")).toHaveLength(3);
  });

  it("keys a Foley scene's sound on exactly what it was keyed on before", async () => {
    const { ctx } = await ltxRun();
    ctx.providers = { ...ctx.providers, sound: new FakeSound(join(ctx.dir, "_fakes")) };
    Object.assign(ctx.prices, FOLEY_RATES);
    ctx.manifest.request.sceneSound = true;
    ctx.manifest.models.sound = "runpod:fo1/sound-foley@1";
    await runPipeline(ctx, MEDIA.slice(0, -1), auto);
    const m = ctx.manifest;
    const sec = sceneSec(ctx, 0);
    // (the phase 14 key, written out: a Foley run's sound is never made again because the stage learnt the clip's sound)
    const before = {
      model: "runpod:fo1/sound-foley@1",
      prompt: m.script!.scenes[0].soundPrompt!.trim(),
      negativePrompt: SOUND_NEGATIVE_PROMPT,
      seed: soundSeed(7, 0, 0),
      guidanceScale: guidanceFor(m.script!.scenes[0].actionLevel),
      steps: SOUND_STEPS,
      audioLengthSec: soundAskSeconds(sec),
      trackSec: Math.round(Math.min(sec, SCENE_SOUND_MAX_SEC) * 1000) / 1000,
      fadeOut: sec > SCENE_SOUND_MAX_SEC,
      still: false,
      picture: await fileSha256(abs(ctx, paths.fitted(0))),
    };
    const now = (await soundStage.inputsFor(ctx, 0)) as Record<string, unknown>;
    expect(now).toEqual(before);
    expect(Object.keys(now)).toEqual(Object.keys(before));
  });

  it("is made again when the clip or the scene's length changes, and not when only the mix level does", async () => {
    const { ctx } = await ltxRun();
    await runPipeline(ctx, MEDIA, auto);
    const key = async () => JSON.stringify(await soundStage.inputsFor(ctx, 0));
    const first = await key();
    ctx.manifest.request.render.sfxGain = 0.1;
    expect(await key()).toBe(first);
    // a longer scene (its picture fitted again to it)
    ctx.manifest.scenes[0].audio!.duration += 0.5;
    expect(await key()).not.toBe(first);
    ctx.manifest.scenes[0].audio!.duration -= 0.5;
    expect(await key()).toBe(first);
    // another clip
    await ffmpeg(["-f", "lavfi", "-i", "color=red:s=180x320:r=24", "-f", "lavfi", "-i", "sine=f=900", "-t", "3", "-c:v", "libx264", "-c:a", "aac", "-shortest", abs(ctx, paths.clip(0))]);
    expect(await key()).not.toBe(first);
  });

  it("is never stretched: a clip shorter than its scene gives a sound that ends, faded, where the clip's sound ends", async () => {
    const { ctx } = await ltxRun();
    await runPipeline(ctx, MEDIA, auto);
    // the last scene's clip, a tenth shorter than its scene (as the clips stage would record it): slowed to fit, its sound is not
    const frames = Math.round((sceneSec(ctx, 2) / 1.1) * 24);
    const short = frames / 24;
    await ffmpeg([
      "-f", "lavfi", "-i", "color=gray:s=180x320:r=24", "-f", "lavfi", "-i", "sine=f=500:sample_rate=48000",
      "-frames:v", String(frames), "-t", String(short), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", abs(ctx, paths.clip(2)),
    ]);
    ctx.manifest.scenes[2].clip!.duration = short;
    await runPipeline(ctx, MEDIA, auto);
    expect(ctx.manifest.scenes[2].fitted!.plan.kind).toBe("slow");
    const sound = ctx.manifest.scenes[2].sound!;
    expect(sceneSec(ctx, 2)).toBeGreaterThan(short + 0.1);
    expect(sound.seconds).toBeCloseTo(short, 1);
    expect(await probeDuration(abs(ctx, sound.path))).toBeCloseTo(short, 1);
  });

  it("is absent from a clip that has none, and from a Wan run", async () => {
    const silent = await ltxRun();
    silent.ltx.silent = true;
    await runPipeline(silent.ctx, MEDIA, auto);
    expect(silent.ctx.manifest.scenes.map((s) => s.sound)).toEqual([undefined, undefined, undefined]);
    expect(sceneStagesShown(silent.ctx.manifest, 0)).not.toContain("sound");

    const wan = await ltxRun({ wan: true });
    await runPipeline(wan.ctx, MEDIA, auto);
    expect(wan.ctx.manifest.scenes.map((s) => s.sound)).toEqual([undefined, undefined, undefined]);
    expect(Object.keys(wan.ctx.manifest.scenes[0].stages)).not.toContain("sound");
  });

  it("is a silent track when a clip whose sound was unknown turns out to have none: done, for nothing, and not made again on resume", async () => {
    const { ctx, ltx } = await ltxRun();
    ltx.silent = true;
    await runPipeline(ctx, MEDIA.slice(0, -1), auto);
    // (as a clip recovered from the bucket without the worker's answer is recorded: whether it has sound is unknown)
    for (const s of ctx.manifest.scenes) delete s.clip!.hasAudio;
    await runPipeline(ctx, MEDIA, auto);
    const m = ctx.manifest;
    for (const i of [0, 1, 2]) {
      const sound = m.scenes[i].sound!;
      expect(sound).toMatchObject({ path: paths.sound(i), source: "clip" });
      expect(sound.seconds).toBeCloseTo(sceneSec(ctx, i), 2);
      expect(await probeDuration(abs(ctx, sound.path))).toBeCloseTo(sceneSec(ctx, i), 1);
      // digital silence throughout
      const log = await ffmpeg(["-i", abs(ctx, sound.path), "-af", "volumedetect", "-f", "null", "-"], { logLevel: "info" });
      expect(Number(/max_volume: (-?[\d.]+) dB/.exec(log)![1])).toBeLessThan(-90);
      expect(m.scenes[i].stages.sound).toMatchObject({ status: "done", costUsd: 0 });
    }
    expect(m.ledger.filter((e) => e.stage === "sound")).toEqual([]);
    expect((await planRun(ctx, MEDIA)).items).toEqual([]);
  });

  it("keeps what the clip carries: its metadata is in the sound, and the clip itself is never rewritten", async () => {
    const { ctx } = await ltxRun();
    await runPipeline(ctx, MEDIA.slice(0, -1), auto);
    const clip = abs(ctx, paths.clip(0));
    const tagged = `${clip}.tagged.mp4`;
    await ffmpeg(["-i", clip, "-c", "copy", "-metadata", "comment=provenance-test", tagged]);
    await ffmpeg(["-i", tagged, "-c", "copy", clip]);
    const before = await fileSha256(clip);
    await runPipeline(ctx, MEDIA, auto);
    expect(await fileSha256(clip)).toBe(before);
    const log = await ffmpeg(["-i", abs(ctx, paths.sound(0)), "-f", "null", "-"], { logLevel: "info" });
    expect(log).toMatch(/comment\s*:\s*provenance-test/);
  });
});
