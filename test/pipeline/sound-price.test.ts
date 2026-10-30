import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadManifest, saveManifest } from "../../src/manifest/store.js";
import { statusOf } from "../../src/studio/status.js";
import { tempDir } from "../helpers/media.js";
import { type RunOptions, planRun, runPipeline } from "../../src/pipeline.js";
import { assertRenderOnly, withLook } from "../../src/rerender.js";
import { STAGES } from "../../src/stages/index.js";
import { soundNotMade } from "../../src/stages/sound.js";
import { planningCopy, planQuery } from "../../src/studio/commands.js";
import type { StageContext } from "../../src/stages/types.js";
import { FakeSound } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

/*
 * Phase 14 spec §6: the credit a video holds covers its scene sound. The studio holds exactly what the CLI's own plan
 * prices (generate, reroll, a series' episode), so what is proved here is that the plan prices the sound.
 */

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const RATES = { runpodFoleyUsdPerSec: 0.0003, runpodFoleySecPerClipSec: 4, runpodFoleyColdStartSec: 90 };

async function run(opts: { sceneSound?: boolean; sfx?: boolean } = {}) {
  const made = await makeTestContext({ modes: [1, 1, 2, 1], seed: 4242 });
  const sound = new FakeSound(join(made.dir, "_fakes"));
  made.ctx.providers = { ...made.ctx.providers, sound };
  Object.assign(made.ctx.prices, RATES);
  if (opts.sceneSound !== false) made.ctx.manifest.request.sceneSound = true;
  if (opts.sfx === false) made.ctx.manifest.request.render.sfx = false;
  made.ctx.manifest.models.sound = "runpod:fo1/sound-foley@1";
  return { ...made, sound };
}

/** What the studio is shown and holds: the CLI's `plan --json`, worked out on a copy. */
const priced = (ctx: StageContext, query: Parameters<typeof planQuery>[2] = {}) => planQuery({ ...ctx, manifest: planningCopy(ctx.manifest) }, STAGES, query);
const soundOf = (plan: Awaited<ReturnType<typeof priced>>) => plan.items.filter((i) => i.stage === "sound");

describe("what a run with scene sound is priced at", () => {
  it("counts every scene's sound in what generating a draft holds, and nothing for a run without it", async () => {
    const withSound = await run();
    await runPipeline(withSound.ctx, STAGES.slice(0, 1), auto);
    const plan = await priced(withSound.ctx);
    expect(soundOf(plan).map((i) => i.scene)).toEqual([1, 2, 3, 4]);
    expect(soundOf(plan).every((i) => i.costUsd > 0)).toBe(true);

    const without = await run({ sceneSound: false });
    await runPipeline(without.ctx, STAGES.slice(0, 1), auto);
    const plain = await priced(without.ctx);
    expect(soundOf(plain)).toEqual([]);
    // the same run, and the difference in what it holds is the sound, to the ten-thousandth
    const sound = soundOf(plan).reduce((sum, i) => sum + i.costUsd, 0);
    expect(Math.round((plan.totalUsd - plain.totalUsd) * 10_000)).toBe(Math.round(sound * 10_000));
  });

  it("counts nothing for sound when its sound effects are off", async () => {
    const { ctx } = await run({ sfx: false });
    await runPipeline(ctx, STAGES.slice(0, 1), auto);
    expect(soundOf(await priced(ctx))).toEqual([]);
  });

  it("prices one scene's new sound, and only it, for a reroll of that scene's sound", async () => {
    const { ctx } = await run();
    await runPipeline(ctx, STAGES, auto);
    const plan = await priced(ctx, { reroll: { scene: 2, stage: "sound" } });
    expect(soundOf(plan).map((i) => i.scene)).toEqual([2]);
    expect(soundOf(plan)[0].costUsd).toBeGreaterThan(0);
    expect(plan.totalUsd).toBeGreaterThanOrEqual(soundOf(plan)[0].costUsd);
    // (and planning it changed nothing in the run)
    expect((await planRun(ctx, STAGES)).items).toEqual([]);
  });
});

describe("a re-render that turns sound effects on", () => {
  it("is refused before anything is stored when the run's sound was never made, and allowed when it was", async () => {
    const { ctx, sound } = await run({ sfx: false });
    await runPipeline(ctx, STAGES, auto);
    expect(sound.submits).toEqual([]);
    expect(soundNotMade(ctx.manifest)).toBe(true);
    const plan = await planRun({ ...ctx, manifest: withLook(ctx.manifest, { sfx: true }) }, STAGES);
    expect(() => assertRenderOnly(plan, "r")).toThrow(/sound scene 1.*use resume/);
    // the copy is the one changed, never the run
    expect(ctx.manifest.request.render.sfx).toBe(false);

    const made = await run();
    await runPipeline(made.ctx, STAGES, auto);
    expect(soundNotMade(made.ctx.manifest)).toBe(false);
    made.ctx.manifest.request.render.sfx = false;
    const again = await planRun({ ...made.ctx, manifest: withLook(made.ctx.manifest, { sfx: true }) }, STAGES);
    expect(() => assertRenderOnly(again, "r")).not.toThrow();
  });

  it("is never a problem for a run made without scene sound", async () => {
    const { ctx } = await run({ sceneSound: false, sfx: false });
    await runPipeline(ctx, STAGES, auto);
    expect(soundNotMade(ctx.manifest)).toBe(false);
  });
});

describe("the CLI's rerender", () => {
  it("refuses to turn sound effects on for a run whose sound was never made, and leaves its look as it was", async () => {
    const { ctx, dir } = await run({ sfx: false });
    await runPipeline(ctx, STAGES, auto);
    const runsDir = resolve(dir, "..");
    const id = dir.slice(runsDir.length + 1);
    ctx.manifest.runId = id;
    await saveManifest(dir, ctx.manifest);
    // its own folder for the CLI, with the sound's prices and no .env: nothing here can reach a provider
    const cwd = await tempDir("flowchain-cli-");
    await writeFile(join(cwd, "prices.json"), JSON.stringify(RATES));
    const tsx = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
    const refused = await promisify(execFile)("node", ["--import", tsx, resolve("src/cli.ts"), "rerender", id, "--sfx"], { cwd, env: { ...process.env, RUNS_DIR: runsDir } }).then(
      () => "",
      (err: { stderr: string }) => err.stderr,
    );
    expect(refused).toMatch(/sound scene 1.*use resume/);
    expect((await loadManifest(dir)).request.render.sfx).toBe(false);
  });
});

describe("a run's status", () => {
  it("says it was made with scene sound only when it was", async () => {
    expect(statusOf((await run()).ctx.manifest).sceneSound).toBe(true);
    expect("sceneSound" in statusOf((await run({ sceneSound: false })).ctx.manifest)).toBe(false);
  });
});
