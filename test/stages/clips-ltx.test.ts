import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { editById } from "../../src/edits.js";
import { fileSha256 } from "../../src/manifest/hash.js";
import { countFrames, probeVideo } from "../../src/media/ffmpeg.js";
import { computeHash, runPipeline, type RunOptions } from "../../src/pipeline.js";
import { PRESETS } from "../../src/presets.js";
import { soundSeed } from "../../src/sound.js";
import { clipSeed, clipsStage } from "../../src/stages/clips.js";
import { fitStage } from "../../src/stages/fit.js";
import { interpolateStage } from "../../src/stages/interpolate.js";
import { upscaleStage } from "../../src/stages/upscale.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { abs, paths } from "../../src/stages/paths.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { WARMUP_KEY } from "../../src/stages/warmup.js";
import { clipPrompt, motionPrompt, sceneFrames } from "../../src/stages/visual.js";
import { videoProfileOf } from "../../src/video-profiles.js";
import { FakeLtxVideo, FakeUpscale } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const LTX_PRICES = { runpodLtxUsdPerSec: 0.0011, runpodLtxSecPerClipSec: 30, runpodLtxColdStartSec: 120 };

/** A run frozen with LTX (as `newRunProviders` freezes one), its clips made by the LTX stand-in. */
async function ltxRun(opts: { seed?: number; shots?: ("cut" | "continue")[] } = {}) {
  const shots = opts.shots ?? ["cut", "continue"];
  const made = await makeTestContext({ modes: shots.map(() => 1 as const), shots, seed: opts.seed ?? 7 });
  const ltx = new FakeLtxVideo(`${made.dir}/_fakes`);
  made.ctx.providers = { ...made.ctx.providers, video: ltx };
  made.ctx.prices = Prices.parse(LTX_PRICES);
  made.ctx.manifest.request.videoProfile = "ltx25@1";
  made.ctx.manifest.models.video = "runpod:ep-l/clip-ltx25@1";
  return { ...made, ltx };
}

describe("the clips stage on LTX", () => {
  it("asks for the scene's own LTX prompt, the short side 640, a whole 8k+1 frames at 24 fps and the scene's seed", async () => {
    const { ctx, ltx } = await ltxRun({ seed: 7 });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    const script = ctx.manifest.script!;
    expect(ltx.submits.map((r) => r.prompt)).toEqual([script.scenes[0].videoPrompt, script.scenes[1].videoPrompt]);
    expect(ltx.submits.map((r) => r.height)).toEqual([640, 640]);
    ltx.submits.forEach((r, i) => {
      const frames = r.durationSec * 24;
      expect(frames).toBeCloseTo(Math.round(frames), 9);
      expect((Math.round(frames) - 1) % 8).toBe(0);
      expect(r.durationSec).toBe(videoProfileOf("ltx25@1").clipSec(ctx.manifest.scenes[i].audio!.duration));
    });
    expect(ltx.submits.map((r) => r.seed)).toEqual([soundSeed(7, 0, 0), soundSeed(7, 1, 0)]);
    // nothing a scene speaks is asked for here (a speaking scene is a later task)
    expect(ltx.submits.every((r) => r.speechLanguage === undefined)).toBe(true);
  });

  it("records the clip's own frame rate and sound on the clip", async () => {
    const { ctx } = await ltxRun();
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    const clip = ctx.manifest.scenes[0].clip!;
    expect(clip).toMatchObject({ path: paths.clip(0), fps: 24, hasAudio: true });
    expect(Object.keys(clip).sort()).toEqual(["duration", "fps", "hasAudio", "path", "requestedSec", "sourceUrl"]);
    expect((await probeVideo(abs(ctx, clip.path))).fps).toBe(24);
  });

  it("keeps an LTX clip's frame rate when a paid result is reused after a stop, and leaves its sound unknown", async () => {
    const { ctx, ltx } = await ltxRun({ shots: ["cut"] });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    // stopped after the job was paid for and before the clip was recorded: only the job's url is on disk
    delete ctx.manifest.scenes[0].clip;
    delete ctx.manifest.scenes[0].stages.clips;
    await runPipeline(ctx, [clipsStage], auto);
    expect(ltx.submits).toHaveLength(1);
    expect(ctx.manifest.scenes[0].clip).toMatchObject({ fps: 24 });
    expect(ctx.manifest.scenes[0].clip!.hasAudio).toBeUndefined();
  });

  it("gives a scene a stable seed that a reroll changes, and a remade clip another one", async () => {
    const { ctx } = await ltxRun({ seed: 7 });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage], auto);
    expect(clipSeed(ctx.manifest, 1)).toBe(soundSeed(7, 1, 0));
    expect(clipSeed(ctx.manifest, 1)).toBe(clipSeed(ctx.manifest, 1));
    expect(clipSeed(ctx.manifest, 0)).not.toBe(clipSeed(ctx.manifest, 1));
    expect(clipSeed(ctx.manifest, 1, 1)).not.toBe(clipSeed(ctx.manifest, 1));
    ctx.manifest.scenes[1].nonces.clips = 1; // what `reroll --scene 2 --stage clips` does
    expect(clipSeed(ctx.manifest, 1)).toBe(soundSeed(7, 1, 1));
    // a reroll is never the clip a remake already made
    ctx.manifest.scenes[1].nonces.clips = 0;
    const remade = clipSeed(ctx.manifest, 1, 1);
    ctx.manifest.scenes[1].nonces.clips = 1;
    expect(clipSeed(ctx.manifest, 1)).not.toBe(remade);
  });

  it("sends a malformed clip's remake with a new seed", async () => {
    const { ctx, ltx, fakes } = await ltxRun({ shots: ["cut"] });
    // (the keyframe is looked at too: only the first look at a clip's frames finds it malformed)
    let clipLooks = 0;
    fakes.llm.inspect = async (req) => (req.images[0].includes("look_") && ++clipLooks === 1 ? { ok: false, problems: ["a third wing"] } : { ok: true });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    expect(ltx.submits).toHaveLength(2);
    expect(ltx.submits[1].seed).toBe(clipSeed(ctx.manifest, 0, 1));
    expect(ltx.submits[1].seed).not.toBe(ltx.submits[0].seed);
  });

  it("falls back to the motion prompt for a scene the script wrote no LTX prompt for", async () => {
    const { ctx, ltx } = await ltxRun({ shots: ["cut"] });
    await runPipeline(ctx, [scriptStage], auto);
    ctx.manifest.script!.scenes[0].videoPrompt = "";
    await runPipeline(ctx, [ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    expect(ltx.submits[0].prompt).toBe(motionPrompt(ctx.manifest.script!, 0, PRESETS.cinematic_history));
  });

  it("keys the clip on the prompt it sends and on its seed", async () => {
    const { ctx } = await ltxRun();
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    const hash = await computeHash(ctx, clipsStage, 0);
    expect(await clipsStage.inputsFor(ctx, 0)).toMatchObject({ prompt: ctx.manifest.script!.scenes[0].videoPrompt, seed: clipSeed(ctx.manifest, 0), height: 640 });
    ctx.manifest.script!.scenes[0].videoPrompt = "A grey fox sits still. Audio: wind.";
    const reprompted = await computeHash(ctx, clipsStage, 0);
    expect(reprompted).not.toBe(hash);
    ctx.manifest.request.seed = 8;
    expect(await computeHash(ctx, clipsStage, 0)).not.toBe(reprompted);
  });

  it("never asks the LTX worker for an early start, and settles none", async () => {
    const { ctx } = await ltxRun();
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    expect(ctx.manifest.warmup).toBeUndefined();
    expect(ctx.manifest.inFlight?.[WARMUP_KEY]).toBeUndefined();
    expect(ctx.manifest.abandonedUsd).toBeUndefined();
  });

  it("fits a 24 fps clip to exactly the scene's frames at the video's rate, and chains from its last shown frame", async () => {
    const { ctx, ltx } = await ltxRun();
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage, fitStage], auto);
    const frames = sceneFrames(ctx.manifest, ctx.fps);
    for (const i of [0, 1]) {
      expect(await countFrames(abs(ctx, paths.fitted(i)))).toBe(frames[i]);
      expect((await probeVideo(abs(ctx, paths.fitted(i)))).fps).toBe(ctx.fps);
    }
    // the continuing clip was started from the seam of the first: the fitted first clip's last frame
    expect(ltx.submits[1].imagePath).toBe(abs(ctx, paths.seam(0)));
  });
});

describe("a Wan run's clips are asked for and keyed exactly as before", () => {
  it("keeps the literal inputs the old code hashed, with no seed, for 480p and 720p", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1], shots: ["cut", "continue"] });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage], auto);
    const m = ctx.manifest;
    m.request.videoProfile = "wan22-480p@1";
    const script = m.script!;
    const old = {
      mode: 1,
      model: m.models.video,
      prompt: motionPrompt(script, 0, PRESETS.cinematic_history, editById(m.request.edit)),
      requestedSec: videoProfileOf("wan22-480p@1").clipSec(m.scenes[0].audio!.duration),
      imageSha: await fileSha256(abs(ctx, paths.keyframe(0))),
    };
    expect(await clipsStage.inputsFor(ctx, 0)).toStrictEqual(old);
    m.request.videoProfile = "wan22-720p@1";
    expect(await clipsStage.inputsFor(ctx, 0)).toStrictEqual({ ...old, requestedSec: videoProfileOf("wan22-720p@1").clipSec(m.scenes[0].audio!.duration), height: 720 });
  });

  it("asks a Wan clip with the motion prompt even when the script wrote an LTX prompt, and records no rate or sound", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1], shots: ["cut"] });
    ctx.manifest.request.videoProfile = "wan22-480p@1";
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    expect(fakes.video.submits[0].prompt).toBe(motionPrompt(ctx.manifest.script!, 0, PRESETS.cinematic_history));
    expect(fakes.video.submits[0].seed).toBeUndefined();
    expect(Object.keys(ctx.manifest.scenes[0].clip!).sort()).toEqual(["duration", "path", "requestedSec", "sourceUrl"]);
  });

  it("clipPrompt is the motion prompt for every profile but LTX", () => {
    // (a script without an LTX prompt at all, as every script before phase 15)
    return makeTestContext({ modes: [1], shots: ["cut"] }).then(async ({ ctx }) => {
      await runPipeline(ctx, [scriptStage], auto);
      const s = ctx.manifest.script!;
      for (const p of [undefined, "kling-v2", "wan22-480p@1", "wan22-720p@1"] as const) {
        expect(clipPrompt(s, 0, PRESETS.anime, undefined, p)).toBe(motionPrompt(s, 0, PRESETS.anime));
      }
      expect(clipPrompt(s, 0, PRESETS.anime, undefined, "ltx25@1")).toBe(s.scenes[0].videoPrompt);
      delete s.scenes[0].videoPrompt;
      expect(clipPrompt(s, 0, PRESETS.anime, undefined, "ltx25@1")).toBe(motionPrompt(s, 0, PRESETS.anime));
    });
  });
});

describe("smooth motion of a clip that is not Wan's", () => {
  it("refuses to interpolate a 24 fps clip before anything is bought (not measured yet)", async () => {
    const { ctx } = await ltxRun({ shots: ["cut"] });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    const restore = new FakeUpscale(`${ctx.dir}/_fakes`);
    ctx.providers = { ...ctx.providers, upscale: restore };
    ctx.prices = Prices.parse({ ...LTX_PRICES, runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 });
    ctx.manifest.request.fps = 60;
    await expect(runPipeline(ctx, [interpolateStage], auto)).rejects.toThrow(/24 frames a second/);
    expect(restore.submits).toHaveLength(0);
  });

  it("refuses the Full HD job that would also interpolate a 24 fps clip, and upscales one in a 30 fps run as before", async () => {
    const { ctx } = await ltxRun({ shots: ["cut"] });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);
    const restore = new FakeUpscale(`${ctx.dir}/_fakes`);
    ctx.providers = { ...ctx.providers, upscale: restore };
    ctx.prices = Prices.parse({ ...LTX_PRICES, runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 });
    ctx.manifest.request.upscale = true;
    ctx.manifest.request.fps = 60;
    await expect(runPipeline(ctx, [upscaleStage], auto)).rejects.toThrow(/24 frames a second/);
    expect(restore.submits).toHaveLength(0);
    delete ctx.manifest.request.fps;
    await runPipeline(ctx, [upscaleStage], auto);
    expect(restore.submits).toHaveLength(1);
  });
});
