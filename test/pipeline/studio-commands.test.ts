import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadManifest, saveManifest } from "../../src/manifest/store.js";
import { type Plan, runPipeline, type RunOptions } from "../../src/pipeline.js";
import { STAGES } from "../../src/stages/index.js";
import { clipsStage } from "../../src/stages/clips.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { modesStage } from "../../src/stages/modes.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { planningCopy, planQuery, RUN_ID, runDraft } from "../../src/studio/commands.js";
import { isDraft } from "../../src/studio/draft.js";
import { makeTestContext } from "../helpers/context.js";

const run = promisify(execFile);
const opts: RunOptions = { budgetUsd: 100, confirm: async () => true };
const MEDIA = [scriptStage, ttsStage, silenceStage, modesStage, keyframesStage, clipsStage];

/** Runs the real CLI on a runs folder; nothing here reaches a provider (plan, status and draft-modes are free). */
async function cli(runsDir: string, ...args: string[]) {
  const { stdout } = await run("node", ["--import", "tsx", resolve("src/cli.ts"), ...args], {
    env: { ...process.env, RUNS_DIR: runsDir },
  });
  return stdout.trim();
}

describe("runDraft", () => {
  it("buys the script and nothing else, then writes provisional modes so the run can be previewed and priced", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", actionLevels: ["high", "medium", "low"] });
    await runDraft(ctx, opts);
    expect(fakes.llm.calls).toHaveLength(1);
    expect(fakes.tts.calls).toHaveLength(0);
    expect(isDraft(ctx.manifest)).toBe(true);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([1, 1, 2]);
    expect(ctx.manifest.scenes.every((s) => s.modeReason === undefined)).toBe(true); // provisional: not decided yet
    const saved = await loadManifest(ctx.dir);
    expect(saved.scenes.map((s) => s.mode)).toEqual([1, 1, 2]);
  });

  it("applies pins given at creation", async () => {
    const { ctx } = await makeTestContext({ modes: "auto", actionLevels: ["high", "medium", "low"] });
    ctx.manifest.request.modeOverrides = [2, 2, 2];
    await runDraft(ctx, opts);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([2, 2, 2]);
  });

  it("leaves an explicit run's modes alone", async () => {
    const { ctx } = await makeTestContext({ modes: [2, 1] });
    await runDraft(ctx, opts);
    expect(ctx.manifest.scenes.map((s) => s.mode)).toEqual([2, 1]);
    expect(ctx.manifest.request.modeOverrides).toBeUndefined();
  });

  it("a draft resumes into the full run, and the modes stage then decides for good with the pins kept", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: "auto", actionLevels: ["high", "medium", "low"] });
    ctx.manifest.request.modeOverrides = [null, 2, null];
    await runDraft(ctx, opts);
    await runPipeline(ctx, MEDIA, opts);
    expect(fakes.llm.calls).toHaveLength(1); // the draft's script is the run's script
    expect(ctx.manifest.scenes.map((s) => [s.mode, s.modeReason])).toEqual([
      [1, "auto: high action"],
      [2, "set by you"],
      [2, "auto: low action"],
    ]);
  });
});

describe("planQuery", () => {
  it("prices a draft's remaining work for its provisional modes and never touches the run", async () => {
    const { ctx } = await makeTestContext({ modes: "auto", actionLevels: ["high", "medium", "low"] });
    await runDraft(ctx, opts);
    const original = structuredClone(ctx.manifest);
    const copy = { ...ctx, manifest: planningCopy(ctx.manifest) };
    const plan = await planQuery(copy, STAGES);
    expect(plan.items.find((i) => i.stage === "script")).toBeUndefined();
    expect(plan.items.filter((i) => i.stage === "tts").map((i) => i.scene)).toEqual([1, 2, 3]);
    expect(plan.items.filter((i) => i.stage === "clips").map((i) => i.scene)).toEqual([1, 2]);
    expect(plan.totalUsd).toBeGreaterThan(0);

    const stills = await planQuery({ ...ctx, manifest: planningCopy(ctx.manifest) }, STAGES, { modes: [2, 2, 2] });
    expect(stills.items.filter((i) => i.stage === "clips")).toEqual([]);
    expect(stills.totalUsd).toBeLessThan(plan.totalUsd);
    expect(ctx.manifest).toEqual(original);
  });

  it("prices a reroll of one scene's stage", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1], shots: ["cut", "cut"] });
    await runPipeline(ctx, MEDIA, opts);
    expect((await planQuery({ ...ctx, manifest: planningCopy(ctx.manifest) }, MEDIA)).items).toEqual([]);
    const plan = await planQuery({ ...ctx, manifest: planningCopy(ctx.manifest) }, MEDIA, { reroll: { scene: 2, stage: "clips" } });
    expect(plan.items).toEqual([{ stage: "clips", scene: 2, costUsd: expect.any(Number) }]);
    expect(plan.totalUsd).toBeGreaterThan(0);
    expect(ctx.manifest.scenes[1].nonces.clips).toBeUndefined();
  });

  it("the run id pattern accepts new ids and nothing path-like", () => {
    expect(RUN_ID.test("20261006-133244-b46307")).toBe(true);
    for (const bad of ["../x", "20261006-133244-b4630", "20261006-133244-B46307", "20261006-133244-b46307/.."]) {
      expect(RUN_ID.test(bad)).toBe(false);
    }
  });
});

describe("the CLI's free commands", () => {
  it("status --json, plan --json and draft-modes work on a draft and agree with each other", async () => {
    const { ctx, dir } = await makeTestContext({ modes: "auto", actionLevels: ["high", "medium", "low"] });
    await runDraft(ctx, opts);
    // the CLI looks runs up by id under RUNS_DIR: this run's folder is its own id under its parent
    const runsDir = resolve(dir, "..");
    const id = dir.slice(runsDir.length + 1);
    ctx.manifest.runId = id;
    await saveManifest(dir, ctx.manifest);

    const status = JSON.parse(await cli(runsDir, "status", id, "--json"));
    expect(status.draft).toBe(true);
    expect(status.scenes.map((s: { mode: number }) => s.mode)).toEqual([1, 1, 2]);

    const before = JSON.parse(await cli(runsDir, "plan", id, "--json"));
    const tried = JSON.parse(await cli(runsDir, "plan", id, "--json", "--modes", "2,2,2"));
    expect(tried.totalUsd).toBeLessThan(before.totalUsd);
    expect((await loadManifest(dir)).request.modeOverrides).toBeUndefined(); // plan saved nothing

    const set = JSON.parse(await cli(runsDir, "draft-modes", id, "--modes", "2,2,2", "--json"));
    expect(set.modes).toEqual([2, 2, 2]);
    expect((await loadManifest(dir)).request.modeOverrides).toEqual([2, 2, 2]);
    expect(JSON.parse(await cli(runsDir, "plan", id, "--json")).totalUsd).toBe(tried.totalUsd);
    expect(await cli(runsDir, "status", id)).toContain(`Run ${id} — 9:16, 3 scenes, modes auto`);
  });

  it("look stores a new look on a draft without rendering or buying; the draft stays a draft", async () => {
    const { ctx, dir, fakes } = await makeTestContext({ modes: "auto" });
    await runDraft(ctx, opts);
    const runsDir = resolve(dir, "..");
    const id = dir.slice(runsDir.length + 1);
    ctx.manifest.runId = id;
    await saveManifest(dir, ctx.manifest);
    const out = await cli(runsDir, "look", id, "--caption-style", "mrbeast", "--no-hook", "--transition", "glitch");
    expect(out).toContain("Hook: off");
    const saved = await loadManifest(dir);
    expect(saved.request.render).toMatchObject({ captionStyle: "mrbeast", hook: false, transition: "glitch" });
    expect(isDraft(saved)).toBe(true);
    expect(saved.runStages.render).toBeUndefined();
    expect(fakes.tts.calls).toHaveLength(0);
  });
});
