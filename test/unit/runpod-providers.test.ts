import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Prices, runpodRates } from "../../src/config.js";
import { createProviders } from "../../src/providers/factory.js";
import { FalImage, FalVideo } from "../../src/providers/fal.js";
import { parseModelId, runpodModelId } from "../../src/providers/model-id.js";
import type { R2 } from "../../src/providers/r2.js";
import { NonRetryableError, UnusableResultError } from "../../src/providers/retry.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { clipFrames, RunpodImage, RunpodVideo, type RunpodDeps } from "../../src/providers/runpod-providers.js";
import { FakeRunpodApi } from "../fakes/runpod.js";
import { makeImage, tempDir } from "../helpers/media.js";

const rates = runpodRates(Prices.parse({}));
const target = { endpointId: "ep-k", workflow: "keyframe-sdxl", version: 1 };

/** An R2 stand-in: `present` lists the keys that exist. */
function fakeR2(present: string[] = []): R2 {
  return {
    exists: async (key: string) => present.includes(key),
    presignGet: async (key: string) => `https://r2.example/${key}?signed`,
  } as unknown as R2;
}

function deps(api: FakeRunpodApi, r2 = fakeR2()): RunpodDeps {
  let t = 0;
  return {
    client: new RunpodClient("k", { fetch: api.fetch }),
    r2,
    rates,
    poll: { pollMs: 1000, sleep: async (ms) => void (t += ms), now: () => t },
  };
}

describe("model ids", () => {
  it("routes runpod:<endpoint>/<workflow>@<version> to RunPod and anything else to fal", () => {
    expect(parseModelId("fal-ai/flux/dev")).toEqual({ provider: "fal", model: "fal-ai/flux/dev" });
    expect(parseModelId(runpodModelId("abc123", "clip-wan22-480p", 1))).toEqual({
      provider: "runpod",
      endpointId: "abc123",
      workflow: "clip-wan22-480p",
      version: 1,
    });
    expect(() => parseModelId("runpod:abc")).toThrow(/invalid RunPod model id/);
  });
});

describe("RunPod request shapes", () => {
  it("asks the keyframe worker for the preset, seed and a base64 reference", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "ref.png"), Buffer.from("portrait-bytes"));
    const image = new RunpodImage(deps(new FakeRunpodApi(() => [])), target);
    const job = await image.prepare({
      prompt: "p",
      width: 1088,
      height: 1920,
      seed: 7,
      preset: "anime",
      referenceImagePath: join(dir, "ref.png"),
    });
    expect(job.input).toEqual({
      task: "keyframe",
      workflow: "keyframe-sdxl@1",
      prompt: "p",
      width: 1088,
      height: 1920,
      preset: "anime",
      seed: 7,
      reference: Buffer.from("portrait-bytes").toString("base64"),
    });
    const plain = await image.prepare({ prompt: "p", width: 1088, height: 1920 });
    expect(plain.input).not.toHaveProperty("reference");
  });

  it("asks the clip worker for the frames the narration needs, at 480p in the image's orientation", async () => {
    const dir = await tempDir();
    await makeImage(join(dir, "tall.png"), { width: 1088, height: 1920 });
    await makeImage(join(dir, "wide.png"), { width: 1920, height: 1088 });
    const video = new RunpodVideo(deps(new FakeRunpodApi(() => [])), { ...target, workflow: "clip-wan22-480p" });
    const tall = await video.prepare({ imagePath: join(dir, "tall.png"), prompt: "m", durationSec: 81 / 16 });
    expect(tall.input).toMatchObject({ task: "clip", workflow: "clip-wan22-480p@1", frames: 81, fps: 16, width: 480, height: 832 });
    expect(typeof tall.input.image).toBe("string");
    const wide = await video.prepare({ imagePath: join(dir, "wide.png"), prompt: "m", durationSec: 33 / 16 });
    expect(wide.input).toMatchObject({ frames: 33, width: 832, height: 480 });
  });

  it("accepts only 4k+1 frames between 33 and 81", () => {
    expect(clipFrames(49 / 16)).toBe(49);
    expect(() => clipFrames(5)).toThrow(/4k\+1 frames/);
    expect(() => clipFrames(85 / 16)).toThrow(/4k\+1 frames/);
  });

  it("refuses an input over 9 MB before anything is bought", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "huge.png"), Buffer.alloc(8 * 1024 * 1024));
    const image = new RunpodImage(deps(new FakeRunpodApi(() => [])), target);
    await expect(image.prepare({ prompt: "p", width: 8, height: 8, referenceImagePath: join(dir, "huge.png") })).rejects.toThrow(
      /limit is 9 MB/,
    );
  });

  it("submits once with RunPod's own caps: 120 s for keyframes, 600 s for clips, 1 h to live", async () => {
    const api = new FakeRunpodApi(() => []);
    const signal = new AbortController().signal;
    await new RunpodImage(deps(api), target).submit({ input: { task: "keyframe" } }, { signal });
    await new RunpodVideo(deps(api), { ...target, endpointId: "ep-c" }).submit({ input: { task: "clip" } }, { signal });
    expect(api.runs.map((r) => [r.endpointId, r.policy])).toEqual([
      ["ep-k", { executionTimeout: 120_000, ttl: 3_600_000 }],
      ["ep-c", { executionTimeout: 600_000, ttl: 3_600_000 }],
    ]);
  });
});

describe("RunPod waiting and billing", () => {
  async function submitted(steps: ConstructorParameters<typeof FakeRunpodApi>[0], r2?: R2) {
    const api = new FakeRunpodApi(steps);
    const image = new RunpodImage(deps(api, r2), target);
    const id = await image.submit({ input: {} }, { signal: new AbortController().signal });
    return { api, image, id };
  }

  it("polls until COMPLETED and charges the measured GPU time", async () => {
    const { image, id } = await submitted(() => [
      { status: "IN_QUEUE" },
      { status: "IN_PROGRESS" },
      { status: "COMPLETED", output: { url: "https://r2/k.png", seed: 41 }, executionTime: 8000 },
    ]);
    expect(await image.wait(id, { timeoutMs: 60_000 })).toEqual({
      url: "https://r2/k.png",
      seed: 41,
      costUsd: Math.round(8 * rates.keyframeUsdPerSec * 10_000) / 10_000,
    });
  });

  it("treats FAILED and TIMED_OUT as billed but unusable, with the measured cost", async () => {
    for (const status of ["FAILED", "TIMED_OUT"] as const) {
      const { image, id } = await submitted(() => [{ status, error: "oom", executionTime: 5000 }]);
      const err = await image.wait(id, { timeoutMs: 60_000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnusableResultError);
      expect((err as UnusableResultError).costUsd).toBeCloseTo(5 * rates.keyframeUsdPerSec, 4);
    }
  });

  it("stops at a cancelled job and at its own wait deadline without buying anything", async () => {
    const cancelled = await submitted(() => [{ status: "CANCELLED" }]);
    await expect(cancelled.image.wait(cancelled.id, { timeoutMs: 60_000 })).rejects.toThrow(/was cancelled/);
    const stuck = await submitted(() => [{ status: "IN_QUEUE" }]);
    await expect(stuck.image.wait(stuck.id, { timeoutMs: 5000 })).rejects.toThrow(/still IN_QUEUE after 5 s/);
    expect(stuck.api.runs).toHaveLength(1);
  });

  it("recovers a job RunPod has forgotten from the bucket, leaving its cost to the estimate", async () => {
    const found = await submitted(() => [{ status: "COMPLETED" }], fakeR2(["flowchain/job-1.png"]));
    found.api.expire(found.id);
    expect(await found.image.wait(found.id, { timeoutMs: 60_000 })).toEqual({
      url: "https://r2.example/flowchain/job-1.png?signed",
      seed: -1,
    });
    const lost = await submitted(() => [{ status: "COMPLETED" }]);
    lost.api.expire(lost.id);
    const err = await lost.image.wait(lost.id, { timeoutMs: 60_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(String(err)).toMatch(/not in the bucket; reroll/);
  });
});

describe("createProviders", () => {
  const env = {
    GEMINI_API_KEY: "g",
    GEMINI_MODEL: "m",
    ELEVENLABS_API_KEY: "e",
    ELEVENLABS_VOICE_ID: "v",
    ELEVENLABS_MODEL: "t",
    FAL_IMAGE_MODEL: "fal-ai/flux/dev",
    FAL_VIDEO_MODEL: "fal-ai/kling",
    FLOWCHAIN_BUDGET_USD: 3,
    RUNS_DIR: "./runs",
    PROVIDER_MODE: "runpod" as const,
  };
  const runpodEnv = {
    ...env,
    RUNPOD_API_KEY: "rk",
    R2_ACCOUNT_ID: "a",
    R2_BUCKET: "b",
    R2_ACCESS_KEY_ID: "i",
    R2_SECRET_ACCESS_KEY: "s",
  };
  const prices = Prices.parse({});

  it("keeps a fal run on fal whatever PROVIDER_MODE says", () => {
    const p = createProviders({ ...env, FAL_KEY: "f" }, { llm: "l", tts: "t", image: "fal-ai/flux/dev", video: "fal-ai/kling" }, prices);
    expect(p.image).toBeInstanceOf(FalImage);
    expect(p.video).toBeInstanceOf(FalVideo);
  });

  it("serves a RunPod run from its own endpoints, with RunPod's longer waits", () => {
    const p = createProviders(
      runpodEnv,
      { llm: "l", tts: "t", image: "runpod:ep-k/keyframe-sdxl@1", video: "runpod:ep-c/clip-wan22-480p@1" },
      prices,
    );
    expect(p.image).toBeInstanceOf(RunpodImage);
    expect(p.video).toBeInstanceOf(RunpodVideo);
    expect([p.image.waitMs, p.video.waitMs]).toEqual([600_000, 1_200_000]);
  });

  it("names the missing key", () => {
    expect(() =>
      createProviders(env, { llm: "l", tts: "t", image: "fal-ai/flux/dev", video: "fal-ai/kling" }, prices),
    ).toThrow("FAL_KEY is not set; this run uses fal models");
    expect(() =>
      createProviders(env, { llm: "l", tts: "t", image: "runpod:ep-k/keyframe-sdxl@1", video: "fal-ai/kling" }, prices),
    ).toThrow("RUNPOD_API_KEY is not set; this run uses RunPod");
  });
});
