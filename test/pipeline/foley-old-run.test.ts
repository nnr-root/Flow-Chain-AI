import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { fileSha256 } from "../../src/manifest/hash.js";
import { loadManifest, saveManifest } from "../../src/manifest/store.js";
import { computeHash, planRun, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { applyRenderOptions, assertRenderOnly, noPaidProviders, withLook } from "../../src/rerender.js";
import { buildRenderProps } from "../../src/stages/build-render-props.js";
import { STAGES } from "../../src/stages/index.js";
import { abs, paths } from "../../src/stages/paths.js";
import { soundStage } from "../../src/stages/sound.js";
import type { StageContext } from "../../src/stages/types.js";
import { sceneFrames } from "../../src/stages/visual.js";
import { FakeLtxVideo } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";
import { makeAudio } from "../helpers/media.js";

/*
 * Foley was removed on 2026-11-02 (phase 15 spec §13.12; its code is at the tag `foley-last`). A run made with it has its
 * scenes' sounds on disk, each with the seed and settings it was bought with. These pins were written against the code
 * before the removal and must hold after it: such a run loads, plans nothing paid, re-renders for free and plays its sounds.
 * The literals below were read from that code and must never change: a key that moved would make a finished run's sound
 * stale, and a stale sound can no longer be bought.
 */

const FOLEY_MODEL = "runpod:fo1/sound-foley@1";
const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const LTX_PRICES = { runpodLtxUsdPerSec: 0.0011, runpodLtxSecPerClipSec: 30, runpodLtxColdStartSec: 120 };
/** The seeds the four scenes of a run seeded 4242 were asked with (`soundSeed(4242, i, 0)` before the removal). */
const SEEDS = [1619226566, 1136938753, 1814256187, 1877758775];
/** The guidance each scene's action level was asked with (high, low, medium, high). */
const GUIDANCE = [5.5, 3.5, 4.5, 5.5];
const NEGATIVE = "speech, voice, vocals, singing, music, narration, noise, distortion";

const sceneSec = (ctx: StageContext, i: number) => sceneFrames(ctx.manifest, ctx.fps)[i] / ctx.fps;

/**
 * A run finished with Foley, as the sound stage left it: its scenes made up to the fit, then each scene's levelled sound on
 * disk with its record, its stage done on the key it was bought on, and its charge in the ledger. `blank` scenes had a
 * script that wrote no sound for them, so nothing was bought there. `ltx`: its clips were made on LTX, and carry a sound
 * of their own that a Foley run never used.
 */
async function finishedFoleyRun(opts: { ltx?: boolean; blank?: number[] } = {}) {
  const made = await makeTestContext({ modes: [1, 1, 2, 1], shots: ["cut", "continue", "cut", "cut"], actionLevels: ["high", "low", "medium", "high"], seed: 4242 });
  const { ctx } = made;
  const m = ctx.manifest;
  if (opts.ltx) {
    ctx.providers = { ...ctx.providers, video: new FakeLtxVideo(`${made.dir}/_fakes`) };
    ctx.prices = Prices.parse(LTX_PRICES);
    m.request.videoProfile = "ltx25@1";
    m.models.video = "runpod:ep-l/clip-ltx25@1";
    m.request.language = "en";
  }
  m.request.sceneSound = true;
  m.models.sound = FOLEY_MODEL;
  await runPipeline(ctx, STAGES.slice(0, STAGES.findIndex((s) => s.name === "fit") + 1), auto);
  for (const i of opts.blank ?? []) m.script!.scenes[i].soundPrompt = "  ";
  for (const s of m.scenes) {
    const i = s.idx;
    if (opts.blank?.includes(i)) continue;
    const seconds = Math.round(Math.min(sceneSec(ctx, i), 10) * 1000) / 1000;
    const file = abs(ctx, paths.sound(i));
    await mkdir(dirname(file), { recursive: true });
    await makeAudio(file, [{ tone: seconds, freq: 300 + 40 * i, db: -20 }]);
    s.sound = { path: paths.sound(i), sha256: await fileSha256(file), seconds, seed: SEEDS[i], guidance: GUIDANCE[i], steps: 50, prompt: m.script!.scenes[i].soundPrompt! };
    const at = new Date().toISOString();
    s.stages.sound = { status: "done", inputHash: await computeHash(ctx, soundStage, i), costUsd: 0.0048, finishedAt: at };
    m.ledger.push({ stage: "sound", scene: i, usd: 0.0048, at });
  }
  await runPipeline(ctx, STAGES, auto);
  await saveManifest(ctx.dir, m);
  return made;
}

const soundsPlayed = (ctx: StageContext) =>
  buildRenderProps(ctx.manifest, { dir: ctx.dir, fontsDir: resolve("assets/fonts"), fps: ctx.fps, size: ctx.size }, []).props.audio.sound.map((s) => s.src);

describe("a run finished with Foley, after Foley was removed", () => {
  it("loads with its sounds' records, plans nothing paid and re-renders for free with a new look, playing the sounds on disk", async () => {
    const { ctx } = await finishedFoleyRun();
    const loaded = await loadManifest(ctx.dir);
    expect(loaded.models.sound).toBe(FOLEY_MODEL);
    expect(loaded.request.sceneSound).toBe(true);
    expect(loaded.scenes.map((s) => s.sound && { seed: s.sound.seed, guidance: s.sound.guidance, steps: s.sound.steps, source: s.sound.source })).toEqual(
      SEEDS.map((seed, i) => ({ seed, guidance: GUIDANCE[i], steps: 50, source: undefined })),
    );
    expect(loaded.final).toBeDefined();

    const free = { ...ctx, manifest: loaded, providers: noPaidProviders() };
    expect((await planRun(free, STAGES)).items).toEqual([]);
    const look = { captionStyle: "mrbeast" };
    const plan = await planRun({ ...free, manifest: withLook(loaded, look) }, STAGES);
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items.every((i) => i.costUsd === 0 && i.stage !== "sound")).toBe(true);
    expect(() => assertRenderOnly(plan, loaded.runId)).not.toThrow();
    applyRenderOptions(loaded, look);
    await runPipeline(free, STAGES, { budgetUsd: 0, confirm: async () => false });
    const after = await loadManifest(ctx.dir);
    expect(after.final).toBeDefined();
    expect(after.ledger.filter((e) => e.stage === "sound")).toHaveLength(4);
    // the render lays down every scene's sound from the file on disk
    expect(soundsPlayed({ ...ctx, manifest: after })).toEqual([0, 1, 2, 3].map((i) => paths.sound(i)));
  }, 180_000);

  it("keys each scene's sound on exactly what it was bought with: the model, the prompt, the seed, the settings and the picture", async () => {
    const { ctx } = await finishedFoleyRun();
    const m = ctx.manifest;
    for (const i of [0, 2]) {
      const sec = sceneSec(ctx, i);
      const asked = Math.max(1, Math.min(Math.round(sec * 10) / 10, 10));
      const key = {
        model: FOLEY_MODEL,
        prompt: `wind and surf, scene ${i + 1}`,
        negativePrompt: NEGATIVE,
        seed: SEEDS[i],
        guidanceScale: GUIDANCE[i],
        steps: 50,
        audioLengthSec: asked,
        trackSec: Math.round(Math.min(sec, 10) * 1000) / 1000,
        fadeOut: sec > 10,
        still: i === 2,
        picture: await fileSha256(abs(ctx, i === 2 ? m.scenes[i].keyframe!.path : paths.fitted(i))),
      };
      const now = (await soundStage.inputsFor(ctx, i)) as Record<string, unknown>;
      expect(now).toEqual(key);
      expect(Object.keys(now)).toEqual(Object.keys(key));
    }
  }, 180_000);

  it("made on LTX, takes no sound out of its clips, not even in a scene its script wrote no sound for", async () => {
    const { ctx } = await finishedFoleyRun({ ltx: true, blank: [1] });
    const m = await loadManifest(ctx.dir);
    expect(m.scenes.map((s) => s.sound?.source)).toEqual([undefined, undefined, undefined, undefined]);
    expect(m.scenes[1].sound).toBeUndefined();
    expect(m.scenes[1].stages.sound).toBeUndefined();
    expect(soundsPlayed({ ...ctx, manifest: m })).toEqual([paths.sound(0), paths.sound(2), paths.sound(3)]);
    expect((await planRun({ ...ctx, manifest: m, providers: noPaidProviders() }, STAGES)).items).toEqual([]);
  }, 180_000);
});
