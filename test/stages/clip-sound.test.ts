import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { fileSha256 } from "../../src/manifest/hash.js";
import { ffmpeg, probeDuration } from "../../src/media/ffmpeg.js";
import { computeHash, planRun, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { LOUDNESS_TARGET_LUFS } from "../../src/sound.js";
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
import { NO_VOICES_SENTENCE, sceneFrames } from "../../src/stages/visual.js";
import { sceneStagesShown } from "../../src/studio/status.js";
import { FakeLtxVideo, fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 15 spec §6: an LTX clip's own sound is a scene's sound, made for nothing from the clip; a speaking scene's sound is
// its voice and nothing more. (An old run made with scene sound keeps what it bought: test/pipeline/foley-old-run.test.ts.)
// §9.4: nothing strips what a clip carries.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const LTX_PRICES = { runpodLtxUsdPerSec: 0.0011, runpodLtxSecPerClipSec: 30, runpodLtxColdStartSec: 120 };
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
    // planned, and free: no price is needed, nothing is bought
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
    // the render lays each one down
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

// Phase 15 spec §13.10: in a narrated video, a character is never heard speaking in an ordinary scene's clip sound.
describe("a voice in an ordinary scene's clip sound", () => {
  it("is asked against in the prompt and listened for in every ordinary scene, and in no speaking scene", async () => {
    const { ctx, ltx } = await ltxRun({ speaking: [1] });
    await runPipeline(ctx, MEDIA, auto);
    const script = ctx.manifest.script!;
    // (scene 1 is made second: the clips stage runs scene by scene)
    const [first, spoken, last] = ltx.submits;
    expect(first.prompt).toBe(script.scenes[0].videoPrompt + NO_VOICES_SENTENCE);
    expect(last.prompt).toBe(script.scenes[2].videoPrompt + NO_VOICES_SENTENCE);
    expect(spoken.prompt).toBe(script.scenes[1].videoPrompt);
    expect([first.detectVoice, spoken.detectVoice, last.detectVoice]).toEqual([true, undefined, true]);
  });

  it("takes the clip's sound out of the video: the scene gets no sound step and the render lays no sound under it", async () => {
    const { ctx, ltx } = await ltxRun();
    const voiced = (req: { prompt: string }) => req.prompt.startsWith(ctx.manifest.script!.scenes[1].videoPrompt!);
    ltx.voiceIn = voiced;
    await runPipeline(ctx, MEDIA.slice(0, -1), auto);
    const m = ctx.manifest;
    expect(m.scenes.map((s) => s.clip!.voiceHeard)).toEqual([false, true, false]);
    expect((await planRun(ctx, MEDIA)).items.filter((i) => i.stage === "sound").map((i) => i.scene)).toEqual([0, 2]);
    await runPipeline(ctx, MEDIA, auto);
    expect(m.scenes[1].sound).toBeUndefined();
    expect(sceneStagesShown(m, 1)).not.toContain("sound");
    expect(props(ctx).audio.sound.map((s) => s.src)).toEqual([paths.sound(0), paths.sound(2)]);
    expect(renderStage.deps(m).filter((d) => d.stage === "sound").map((d) => d.scene)).toEqual([0, 2]);
  });

  it("is never played from a sound kept from an earlier clip of a scene whose new clip was heard to carry a voice", async () => {
    const { ctx } = await ltxRun();
    await runPipeline(ctx, MEDIA, auto);
    expect(props(ctx).audio.sound).toHaveLength(3);
    // (as a clip made again carries a voice: the sound taken from the clip before it is still on record)
    ctx.manifest.scenes[1].clip!.voiceHeard = true;
    expect(ctx.manifest.scenes[1].sound).toBeDefined();
    expect(props(ctx).audio.sound.map((s) => s.src)).toEqual([paths.sound(0), paths.sound(2)]);
  });

  it("is not listened for in an old run made with scene sound, whose clip sound is never used, and the clip's key is the same either way", async () => {
    const { ctx, ltx } = await ltxRun();
    ctx.manifest.request.sceneSound = true;
    ctx.manifest.models.sound = "runpod:fo1/sound-foley@1";
    await runPipeline(ctx, MEDIA.slice(0, -2), auto);
    const withSceneSound = await computeHash(ctx, clipsStage, 0);
    await runPipeline(ctx, MEDIA.slice(0, -1), auto);
    expect(ltx.submits.map((r) => r.detectVoice)).toEqual([undefined, undefined, undefined]);
    // (not asked, so not taken as heard: unknown, as the voice of a clip whose sound is replaced by a bought one is)
    expect(ctx.manifest.scenes.map((s) => s.clip!.voiceHeard)).toEqual([undefined, undefined, undefined]);
    delete ctx.manifest.request.sceneSound;
    expect(await computeHash(ctx, clipsStage, 0)).toBe(withSceneSound);
  });

  it("leaves a clip whose voice is unknown, as in a run made before the check, with its sound as before", async () => {
    const { ctx } = await ltxRun();
    await runPipeline(ctx, MEDIA.slice(0, -1), auto);
    for (const s of ctx.manifest.scenes) delete s.clip!.voiceHeard;
    await runPipeline(ctx, MEDIA, auto);
    expect(ctx.manifest.scenes.map((s) => s.sound?.source)).toEqual(["clip", "clip", "clip"]);
  });
});
