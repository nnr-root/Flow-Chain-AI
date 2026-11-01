import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { clipsStage } from "../../src/stages/clips.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { abs, paths } from "../../src/stages/paths.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { makeTestContext } from "../helpers/context.js";
import { makeVideo } from "../helpers/media.js";

// A paid job's file is downloaded once, and its provider copy is then taken away: a kept result reused later takes the
// run's own copy, never a url that answers 404.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const MADE = [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage];

let server: ReturnType<typeof createServer>;
let gone: string;
let broken: string;
beforeAll(async () => {
  server = createServer((req, res) => res.writeHead(req.url?.includes("broken") ? 500 : 404).end());
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  gone = `http://127.0.0.1:${(server.address() as AddressInfo).port}/flowchain-outputs/clip.mp4`;
  broken = `http://127.0.0.1:${(server.address() as AddressInfo).port}/broken/clip.mp4`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

/** A one-clip run, made; then stopped as if after its clip's job was charged and before the stage finished. */
async function madeAndStopped() {
  const made = await makeTestContext({ modes: [1], shots: ["cut"] });
  await runPipeline(made.ctx, MADE, auto);
  const scene = made.ctx.manifest.scenes[0];
  const kept = scene.jobs.clips!.result!;
  delete scene.clip;
  delete scene.stages.clips;
  return { ...made, kept, file: abs(made.ctx, paths.clip(0)) };
}

describe("a kept job's file", () => {
  it("is recorded by its size once downloaded, and nothing else of a Wan clip's record changes", async () => {
    const { ctx } = await makeTestContext({ modes: [1], shots: ["cut"] });
    await runPipeline(ctx, MADE, auto);
    const result = ctx.manifest.scenes[0].jobs.clips!.result!;
    expect(Object.keys(result).sort()).toEqual(["savedBytes", "url"]);
    expect(result.savedBytes).toBe((await stat(abs(ctx, paths.clip(0)))).size);
    expect(Object.keys(ctx.manifest.scenes[0].clip!).sort()).toEqual(["duration", "path", "requestedSec", "sourceUrl"]);
    // every stage that downloads a job's file records it the same way
    expect(ctx.manifest.scenes[0].jobs.keyframes!.result!.savedBytes).toBe((await stat(abs(ctx, paths.keyframe(0)))).size);
  });

  it("is taken from the run on reuse, with no download and no new job", async () => {
    const { ctx, fakes, kept, logs } = await madeAndStopped();
    // the provider's copy is gone: a download would fail
    await rm(fileURLToPath(kept.url));
    await runPipeline(ctx, [clipsStage], auto);
    expect(fakes.video.submits).toHaveLength(1);
    expect(ctx.manifest.scenes[0].clip).toBeDefined();
    expect(logs.some((l) => l.includes("already here; nothing is downloaded"))).toBe(true);
  });

  it("fails the scene with what to do when the run's copy and the provider's are both gone", async () => {
    const { ctx, fakes, kept, file } = await madeAndStopped();
    // the bucket answers that nothing is there
    kept.url = gone;
    await rm(file);
    await expect(runPipeline(ctx, [clipsStage], auto)).rejects.toThrow("scene 1: this scene's clip file is gone; make the scene's clip again");
    expect(fakes.video.submits).toHaveLength(1);
  });

  it("is not said to be gone when the download failed for another reason, which is said as it is", async () => {
    const { ctx, kept, file } = await madeAndStopped();
    kept.url = broken;
    await rm(file);
    const error = await runPipeline(ctx, [clipsStage], auto).catch((e: Error) => e);
    expect(String(error)).toMatch(/HTTP 500/);
    expect(String(error)).not.toMatch(/is gone/);
  });

  it("is taken from the run, for a result kept before sizes were written, when its url answers 404 and the clip is as long as was asked", async () => {
    const { ctx, fakes, kept, logs } = await madeAndStopped();
    kept.url = gone;
    delete kept.savedBytes;
    await runPipeline(ctx, [clipsStage], auto);
    expect(fakes.video.submits).toHaveLength(1);
    expect(logs.some((l) => l.includes("the copy already in the run is used"))).toBe(true);
    expect(kept.savedBytes).toBe((await stat(abs(ctx, paths.clip(0)))).size);
  });

  it("is not taken, for such a result, when the clip on disk is not as long as was asked", async () => {
    const { ctx, kept, file } = await madeAndStopped();
    kept.url = gone;
    delete kept.savedBytes;
    // a clip of another length at the clip's path: it is not this job's
    await makeVideo(file, { seconds: 1, fps: 24, width: 180, height: 320 });
    await expect(runPipeline(ctx, [clipsStage], auto)).rejects.toThrow(/HTTP 404/);
  });

  it("is an error still when a job that has just finished answers 404, though a clip is at its path", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1], shots: ["cut"] });
    await runPipeline(ctx, MADE, auto);
    bumpNonce(ctx.manifest, 1, "clips");
    fakes.video.wait = async () => ({ url: gone });
    await expect(runPipeline(ctx, [clipsStage], auto)).rejects.toThrow(/HTTP 404/);
  });
});
