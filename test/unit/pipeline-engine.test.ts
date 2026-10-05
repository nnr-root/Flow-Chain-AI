import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Prices } from "../../src/config.js";
import { fileSha256 } from "../../src/manifest/hash.js";
import { createManifest, loadManifest } from "../../src/manifest/store.js";
import { formatPlan, planRun, RunAborted, type RunOptions, runPipeline } from "../../src/pipeline.js";
import type { Providers } from "../../src/providers/types.js";
import type { Stage, StageContext } from "../../src/stages/types.js";

type Toy = { log: string[]; failKeyframe?: number };

/** Three toy stages that write random content, so re-running one changes its downstream hashes. */
function toyStages(toy: Toy): Stage[] {
  const write = (ctx: StageContext, rel: string) => writeFile(join(ctx.dir, rel), `${rel}:${Math.random()}`);
  return [
    {
      name: "script", perScene: false, paid: true,
      deps: () => [],
      inputsFor: async (ctx) => ({ topic: ctx.manifest.request.topic }),
      outputsFor: () => ["script.txt"],
      estimateCostUsd: () => 0.01,
      run: async (ctx) => {
        toy.log.push("script");
        await write(ctx, "script.txt");
        await ctx.charge(0.01);
      },
    },
    {
      name: "tts", perScene: true, paid: true,
      deps: () => [{ stage: "script" }],
      inputsFor: async (ctx) => ({ script: await fileSha256(join(ctx.dir, "script.txt")) }),
      outputsFor: (_m, i) => [`tts_${i}.txt`],
      estimateCostUsd: () => 0.1,
      run: async (ctx, i) => {
        toy.log.push(`tts${i}`);
        await write(ctx, `tts_${i}.txt`);
        await ctx.charge(0.1);
      },
    },
    {
      name: "keyframes", perScene: true, paid: true,
      deps: (_m, i) => [{ stage: "tts", scene: i }],
      inputsFor: async (ctx, i) => ({ tts: await fileSha256(join(ctx.dir, `tts_${i}.txt`)) }),
      outputsFor: (_m, i) => [`kf_${i}.txt`],
      estimateCostUsd: () => 1,
      run: async (ctx, i) => {
        toy.log.push(`kf${i}`);
        await ctx.charge(1);
        if (toy.failKeyframe === i) throw new Error("kf boom");
        await write(ctx, `kf_${i}.txt`);
      },
    },
  ];
}

async function toyContext(): Promise<StageContext> {
  const dir = await mkdtemp(join(tmpdir(), "fc-pipe-"));
  const manifest = createManifest(
    "toy",
    { topic: "t", aspect: "9:16", sceneCount: 3, modes: [1, 1, 1], voiceId: "v" },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );
  return {
    dir, manifest, providers: {} as Providers, prices: Prices.parse({}),
    size: { width: 180, height: 320 }, keyframeSize: { width: 192, height: 336 },
    fps: 30, fontsDir: "", sfxDir: "", retryDelayMs: 0, log: () => {},
  };
}

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("runPipeline", () => {
  it("runs everything once, records results and the ledger", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    await runPipeline(ctx, toyStages(toy), auto);
    expect(toy.log).toEqual(["script", "tts0", "tts1", "tts2", "kf0", "kf1", "kf2"]);
    const saved = await loadManifest(ctx.dir);
    expect(saved.ledger).toHaveLength(7);
    expect(saved.ledger.reduce((a, e) => a + e.usd, 0)).toBeCloseTo(3.31, 6);
    expect(saved.runStages.script?.status).toBe("done");
    expect(saved.scenes[2].stages.keyframes?.status).toBe("done");
  });

  it("skips fresh work on a second run", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    await runPipeline(ctx, toyStages(toy), auto);
    await runPipeline(ctx, toyStages(toy), auto);
    expect(toy.log).toHaveLength(7);
  });

  it("re-runs a scene and its dependents after a nonce bump, and prices that cascade up front", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const stages = toyStages(toy);
    await runPipeline(ctx, stages, auto);
    ctx.manifest.scenes[1].nonces.tts = 1;
    const plan = await planRun(ctx, stages);
    expect(plan.items).toEqual([
      { stage: "tts", scene: 1, costUsd: 0.1 },
      { stage: "keyframes", scene: 1, costUsd: 1 },
    ]);
    expect(plan.totalUsd).toBeCloseTo(1.1, 6);
    await runPipeline(ctx, stages, auto);
    expect(toy.log.slice(7)).toEqual(["tts1", "kf1"]);
  });

  it("saves a failed record and resumes from it", async () => {
    const toy: Toy = { log: [], failKeyframe: 1 };
    const ctx = await toyContext();
    await expect(runPipeline(ctx, toyStages(toy), auto)).rejects.toThrow("kf boom");
    const saved = await loadManifest(ctx.dir);
    expect(saved.scenes[1].stages.keyframes).toMatchObject({ status: "failed", error: "kf boom" });
    expect(toy.log).not.toContain("kf2");
    toy.failKeyframe = undefined;
    await runPipeline(ctx, toyStages(toy), auto);
    expect(toy.log.slice(-2)).toEqual(["kf1", "kf2"]);
  });

  it("ctx.charge records spend immediately, even when the stage then fails", async () => {
    const toy: Toy = { log: [], failKeyframe: 1 };
    const ctx = await toyContext();
    await expect(runPipeline(ctx, toyStages(toy), auto)).rejects.toThrow("kf boom");
    const saved = await loadManifest(ctx.dir);
    expect(saved.scenes[1].stages.keyframes).toMatchObject({ status: "failed", costUsd: 1 });
    expect(saved.ledger.filter((e) => e.stage === "keyframes").map((e) => e.scene)).toEqual([0, 1]);

    toy.failKeyframe = undefined;
    await runPipeline(ctx, toyStages(toy), auto);
    // the record carries the total charged for this inputHash across attempts
    expect(ctx.manifest.scenes[1].stages.keyframes).toMatchObject({ status: "done", costUsd: 2 });
    expect(ctx.manifest.scenes[2].stages.keyframes).toMatchObject({ status: "done", costUsd: 1 });
  });

  it("asks before exceeding the budget and runs nothing when declined", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const confirm = vi.fn(async () => false);
    await expect(runPipeline(ctx, toyStages(toy), { budgetUsd: 1, confirm })).rejects.toBeInstanceOf(RunAborted);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ totalUsd: 3.31 }), "over the $1.00 budget");
    expect(toy.log).toEqual([]);
  });

  it("--yes skips confirmation", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const confirm = vi.fn(async () => false);
    await runPipeline(ctx, toyStages(toy), { budgetUsd: 0, confirm, yes: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(toy.log).toHaveLength(7);
  });

  it("a reroll confirms paid work even under budget, once", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const stages = toyStages(toy);
    await runPipeline(ctx, stages, auto);
    ctx.manifest.scenes[0].nonces.tts = 1;
    const confirm = vi.fn(async () => true);
    await runPipeline(ctx, stages, { budgetUsd: 100, confirm, reroll: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.anything(), "reroll");
  });

  it("--from forces that stage and every later one", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const stages = toyStages(toy);
    await runPipeline(ctx, stages, auto);
    await runPipeline(ctx, stages, { ...auto, from: "tts" });
    expect(toy.log.slice(7)).toEqual(["tts0", "tts1", "tts2", "kf0", "kf1", "kf2"]);
  });
});

describe("formatPlan", () => {
  it("renders one row per step with 1-based scene numbers", () => {
    const text = formatPlan(
      {
        items: [
          { stage: "script", costUsd: 0.0055 },
          { stage: "clips", scene: 1, costUsd: 0.25 },
          { stage: "fit", scene: 1, costUsd: 0 },
        ],
        totalUsd: 0.256,
      },
      "Plan",
    );
    expect(text).toBe(
      [
        "Plan: 3 step(s), estimated $0.26",
        "  script    run         $0.0055",
        "  clips     scene 2     $0.2500",
        "  fit       scene 2     free",
      ].join("\n"),
    );
  });

  it("says when there is nothing to do", () => {
    expect(formatPlan({ items: [], totalUsd: 0 }, "Media plan")).toBe("Media plan: nothing to do");
  });
});
