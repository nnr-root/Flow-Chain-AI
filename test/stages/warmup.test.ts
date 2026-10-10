import { describe, expect, it } from "vitest";
import type { Mode } from "../../src/manifest/schema.js";
import { loadManifest } from "../../src/manifest/store.js";
import { type RunOptions, runPipeline } from "../../src/pipeline.js";
import { STAGES } from "../../src/stages/index.js";
import { WARMUP_KEY } from "../../src/stages/warmup.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
type Warmable = { warm?: () => Promise<string>; warmCost?: () => Promise<number> };

/** A run on the picture worker whose clip provider can be started early; `events` is what was asked for, in order. */
async function run(modes: Mode[], opts: { warm?: () => Promise<string>; warmCost?: (onDisk: unknown) => Promise<number> } = {}) {
  const made = await makeTestContext({ modes, shots: modes.map(() => "cut" as const) });
  const { ctx, fakes } = made;
  ctx.manifest.request.imageProfile = "runpod-klein@1";
  const events: string[] = [];
  const video = fakes.video as unknown as Warmable;
  video.warm = async () => {
    events.push("warm");
    return opts.warm ? opts.warm() : "warm-1";
  };
  video.warmCost = async () => {
    events.push("warm cost");
    const onDisk = (await loadManifest(ctx.dir)) as { inFlight?: Record<string, number>; warmup?: unknown };
    return opts.warmCost ? opts.warmCost(onDisk) : 0.0301;
  };
  for (const [name, fake] of [["picture", fakes.image], ["clip", fakes.video]] as const) {
    const submit = fake.submit.bind(fake);
    fake.submit = async (...args: Parameters<typeof submit>) => {
      events.push(name);
      return submit(...args);
    };
  }
  await runPipeline(ctx, STAGES, auto);
  return { ...made, events };
}

describe("the clip worker's early start", () => {
  it("is asked for once, before the portrait of a short run, and paid for with the first clip", async () => {
    let seen: { inFlight?: Record<string, number>; warmup?: unknown } = {};
    const { ctx, events } = await run([1, 1], { warmCost: async (onDisk) => ((seen = onDisk as typeof seen), 0.0301) });
    // portrait, two keyframes: the worker is asked to start before the first of them, and never again
    expect(events).toEqual(["warm", "picture", "picture", "picture", "warm cost", "clip", "clip"]);
    // while it was on its way, what it would cost and which request it was were on disk
    expect(seen.inFlight).toEqual({ [WARMUP_KEY]: 0.0275 }); // 90 s of the clip card
    expect(seen.warmup).toMatchObject({ requestId: "warm-1" });
    // afterwards it is a ledger entry of the first clip, and no longer in flight
    const m = await loadManifest(ctx.dir);
    expect(m.ledger.filter((e) => e.stage === "clips").map((e) => [e.scene, e.usd])[0]).toEqual([0, 0.0301]);
    expect(m.inFlight).toBeUndefined();
    expect(m.warmup).toBeUndefined();
    expect(m.abandonedUsd).toBeUndefined();
  });

  it("waits, in a long run, until the pictures left take no longer than the worker's start", async () => {
    const { events } = await run([1, 2, 2, 2, 2, 2, 2, 2]);
    // nine pictures: at the portrait and the first keyframes there is too much left; a worker started then would
    // have stopped again (and been paid for) before its first clip
    expect(events.indexOf("warm")).toBeGreaterThan(events.indexOf("picture"));
    expect(events.filter((e) => e === "warm")).toHaveLength(1);
    expect(events.slice(0, events.indexOf("warm")).filter((e) => e === "picture")).toHaveLength(1);
  });

  it("is not asked for when the run makes no clip", async () => {
    const { ctx, events } = await run([2, 2]);
    expect(events).toEqual(["picture", "picture", "picture"]);
    expect(ctx.manifest.inFlight).toBeUndefined();
  });

  it("costs nothing and stops nothing when it cannot be asked for", async () => {
    const { ctx, events } = await run([1, 2], { warm: async () => Promise.reject(new Error("RunPod run failed: HTTP 500")) });
    expect(events.filter((e) => e === "clip")).toHaveLength(1);
    expect(events).not.toContain("warm cost");
    expect(ctx.manifest.inFlight).toBeUndefined();
    expect(ctx.manifest.abandonedUsd).toBeUndefined();
    expect(ctx.manifest.final).toBeDefined();
  });

  it("is kept at what was expected when its cost cannot be learnt, and the run goes on", async () => {
    const { ctx } = await run([1, 2], { warmCost: async () => Promise.reject(new Error("RunPod no longer knows warm-up warm-1")) });
    const m = await loadManifest(ctx.dir);
    expect(m.abandonedUsd).toBe(0.0275);
    expect(m.inFlight).toBeUndefined();
    expect(m.warmup).toBeUndefined();
    expect(m.final).toBeDefined();
  });
});
