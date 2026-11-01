import { PresetName } from "../../src/presets.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LTX_RATES_MISSING, Prices, runpodRates } from "../../src/config.js";
import { createProviders } from "../../src/providers/factory.js";
import { parseModelId, runpodModelId } from "../../src/providers/model-id.js";
import type { R2 } from "../../src/providers/r2.js";
import { NonRetryableError, UnusableResultError } from "../../src/providers/retry.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { clipFrames, clipSize, RunpodImage, RunpodUpscale, RunpodVideo, type RunpodDeps } from "../../src/providers/runpod-providers.js";
import { FakeRunpodApi } from "../fakes/runpod.js";
import { makeImage, tempDir } from "../helpers/media.js";

const rates = runpodRates(Prices.parse({}));
const target = { endpointId: "ep-k", workflow: "keyframe-sdxl", version: 1 };

/** An R2 stand-in: `present` lists the keys that exist; what was deleted is noted in `deleted`. */
const deleted: string[] = [];
let failDelete = false;
function fakeR2(present: string[] = []): R2 {
  return {
    exists: async (key: string) => present.includes(key),
    presignGet: async (key: string) => `https://r2.example/${key}?signed`,
    delete: async (key: string) => {
      if (failDelete) throw new Error("R2 DELETE failed: HTTP 500");
      deleted.push(key);
    },
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
  it("routes runpod:<endpoint>/<workflow>@<version> to the GPU endpoints and marks anything else as a retired hosted model", () => {
    expect(parseModelId("fal-ai/flux/dev")).toEqual({ provider: "retired", model: "fal-ai/flux/dev" });
    expect(parseModelId(runpodModelId("abc123", "clip-wan22-480p", 1))).toEqual({
      provider: "runpod",
      endpointId: "abc123",
      workflow: "clip-wan22-480p",
      version: 1,
    });
    expect(() => parseModelId("runpod:abc")).toThrow(/invalid RunPod model id/);
    // the LTX clip's workflow id (phase 15) is admitted and round-trips
    expect(parseModelId("runpod:abc/clip-ltx25@1")).toEqual({ provider: "runpod", endpointId: "abc", workflow: "clip-ltx25", version: 1 });
    expect(runpodModelId("abc", "clip-ltx25", 1)).toBe("runpod:abc/clip-ltx25@1");
  });
});

describe("RunPod request shapes", () => {
  it("asks the keyframe worker for the seed and a base64 reference, and never names the style", async () => {
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
      seed: 7,
      reference: Buffer.from("portrait-bytes").toString("base64"),
    });
    // the worker that is deployed refuses a style it was not built knowing, and uses the name for nothing:
    // a picture in any style is asked for the same way
    for (const preset of PresetName.options) expect((await image.prepare({ prompt: "p", width: 1088, height: 1920, preset })).input, preset).not.toHaveProperty("preset");
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

  it("sends a clip to be upscaled inside the request, with the short side asked for (phase 8 spec §8)", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "clip.mp4"), Buffer.from("mp4-bytes"));
    const up = new RunpodUpscale(deps(new FakeRunpodApi(() => [])), { ...target, workflow: "upscale-seedvr2" });
    const job = await up.prepare({ videoPath: join(dir, "clip.mp4"), short: 1080 });
    expect(job.input).toEqual({ task: "upscale", workflow: "upscale-seedvr2@1", video: Buffer.from("mp4-bytes").toString("base64"), short: 1080 });
    const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output: { url: "https://r2/hd.mp4" }, executionTime: 200_000 }]);
    const billed = new RunpodUpscale(deps(api), { ...target, endpointId: "ep-u", workflow: "upscale-seedvr2" });
    const id = await billed.submit({ input: {} }, { signal: new AbortController().signal });
    expect(api.runs[0].policy).toEqual({ executionTimeout: 900_000, ttl: 3_600_000 });
    expect(await billed.wait(id, { timeoutMs: 60_000 })).toMatchObject({ url: "https://r2/hd.mp4", costUsd: 0.0612 }); // 200 s x $0.000306/s
  });

  it("accepts only 4k+1 frames between 33 and 81", () => {
    expect(clipFrames(49 / 16)).toBe(49);
    expect(() => clipFrames(5)).toThrow(/4k\+1 frames/);
    expect(() => clipFrames(5)).toThrow(NonRetryableError); // a deterministic failure is not retried
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
    expect(await image.wait(id, { timeoutMs: 60_000 })).toMatchObject({
      url: "https://r2/k.png",
      seed: 41,
      costUsd: 0.0024, // 8 s x $0.000306/s = 0.002448, rounded to 4 decimals
    });
  });

  it("charges a clip's GPU time at the clip endpoint's rate", async () => {
    const api = new FakeRunpodApi(() => [
      { status: "COMPLETED", output: { url: "https://r2/c.mp4" }, executionTime: 120_000 },
    ]);
    const video = new RunpodVideo(deps(api), { ...target, endpointId: "ep-c", workflow: "clip-wan22-480p" });
    const id = await video.submit({ input: {} }, { signal: new AbortController().signal });
    const clip = await video.wait(id, { timeoutMs: 60_000 });
    expect(clip).toMatchObject({ url: "https://r2/c.mp4", costUsd: 0.0367 }); // 120 s x $0.000306/s
    // Once the run has its own copy, the worker's upload is taken out of the bucket: by the job's own key,
    // never by anything in the answer. A removal that fails loses nothing that was paid for.
    deleted.length = 0;
    await clip.remove!();
    expect(deleted).toEqual([`flowchain/${id}.mp4`]);
    failDelete = true;
    await expect(clip.remove!()).resolves.toBeUndefined();
    failDelete = false;
  });

  it("treats FAILED and TIMED_OUT as billed but unusable, with the measured cost", async () => {
    for (const status of ["FAILED", "TIMED_OUT"] as const) {
      const { image, id } = await submitted(() => [{ status, error: "oom", executionTime: 5000 }]);
      const err = await image.wait(id, { timeoutMs: 60_000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnusableResultError);
      expect((err as UnusableResultError).costUsd).toBe(0.0015); // 5 s x $0.000306/s = 0.00153
    }
  });

  it("charges nothing for a FAILED or TIMED_OUT job that reports no execution time (it never reached a GPU)", async () => {
    for (const executionTime of [undefined, 0]) {
      for (const status of ["FAILED", "TIMED_OUT"] as const) {
        const { image, id } = await submitted(() => [{ status, error: "no worker", executionTime }]);
        const err = await image.wait(id, { timeoutMs: 60_000 }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnusableResultError);
        expect((err as UnusableResultError).costUsd).toBe(0);
      }
    }
  });

  it("leaves a COMPLETED job without execution time to the stage's estimate", async () => {
    const { image, id } = await submitted(() => [{ status: "COMPLETED", output: { url: "https://r2/k.png" } }]);
    expect(await image.wait(id, { timeoutMs: 60_000 })).toMatchObject({ url: "https://r2/k.png", seed: -1 });
  });

  it("warns when a COMPLETED job measures exactly $0 despite an execution time", async () => {
    const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output: { url: "https://r2/k.png" }, executionTime: 0 }]);
    const warnings: string[] = [];
    const image = new RunpodImage({ ...deps(api), log: (m) => warnings.push(m) }, target);
    const id = await image.submit({ input: {} }, { signal: new AbortController().signal });
    await image.wait(id, { timeoutMs: 60_000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/job-1.*\$0.*milliseconds/);
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
    expect(await found.image.wait(found.id, { timeoutMs: 60_000 })).toMatchObject({
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
    ELEVENLABS_MODEL: "eleven_multilingual_v2",
    FLOWCHAIN_BUDGET_USD: 3,
    FLOWCHAIN_VOICE: "narrator-m",
    FLOWCHAIN_CUT_REFERENCES: "off" as const,
    FLOWCHAIN_SMOOTH_MOTION: "off" as const,
    FLOWCHAIN_TREND_IDEAS: "off" as const,
    FLOWCHAIN_SCENE_SOUND: "off" as const,
    RUNS_DIR: "./runs",
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

  it("loads a run made on a hosted model without any key for it, and refuses to buy anything more for it", async () => {
    const p = createProviders(env, { llm: "l", tts: "t", image: "fal-ai/flux/dev", video: "fal-ai/kling" }, prices);
    const why = /hosted model this studio no longer uses; it can be re-rendered \(rerender\), but nothing new can be bought/;
    await expect(p.image.prepare({ prompt: "p", width: 16, height: 16 })).rejects.toThrow(why);
    await expect(p.image.submit({ input: {} }, { signal: new AbortController().signal })).rejects.toThrow(why);
    // a job such a run left pending can no longer be collected either: it is refused, never retried
    await expect(p.video.wait("old-request", { timeoutMs: 1 })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(p.video.prepare({ imagePath: "x.png", prompt: "p", durationSec: 5 })).rejects.toThrow(/clips came from fal-ai\/kling/);
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
    // a RunPod submit uploads the image inside the request, so it gets three minutes instead of the 60 s default
    expect([p.image.submitMs, p.video.submitMs]).toEqual([180_000, 180_000]);
  });

  it("names the missing key", () => {
    expect(() =>
      createProviders(env, { llm: "l", tts: "t", image: "runpod:ep-k/keyframe-sdxl@1", video: "fal-ai/kling" }, prices),
    ).toThrow("RUNPOD_API_KEY is not set; this run uses RunPod");
  });
});

describe("the size a clip is made at", () => {
  it("is 480p unless the run asks for 720p, upright or on its side like its picture", () => {
    expect(clipSize(undefined, true)).toEqual({ width: 480, height: 832 });
    expect(clipSize(480, false)).toEqual({ width: 832, height: 480 });
    expect(clipSize(720, true)).toEqual({ width: 720, height: 1280 });
    expect(clipSize(720, false)).toEqual({ width: 1280, height: 720 });
    // nothing else is ever sent to the worker: a size it was not measured at is refused here, before a job is bought
    for (const other of [1080, 360, 0]) expect(() => clipSize(other, true)).toThrow("480p or 720p");
  });
});


describe("the clip worker's early start (RunPod)", () => {
  const clipTarget = { endpointId: "ep-c", workflow: "clip-wan22-480p", version: 1 };
  const signal = () => new AbortController().signal;

  it("asks the clip endpoint for a job that carries nothing of the run, and reads its cost from the measured time", async () => {
    const api = new FakeRunpodApi(() => [{ status: "IN_QUEUE" }, { status: "IN_PROGRESS" }, { status: "COMPLETED", output: { warmedBytes: 1 }, executionTime: 100_000 }]);
    const video = new RunpodVideo(deps(api), clipTarget);
    const id = await video.warm!({ signal: signal() });
    expect(api.runs).toEqual([expect.objectContaining({ endpointId: "ep-c", input: { task: "warm" }, policy: { executionTimeout: 300_000, ttl: 900_000 } })]);
    expect(await video.warmCost!(id, { timeoutMs: 60_000 })).toBe(0.0306); // 100 s × $0.000306
    expect(api.runs).toHaveLength(1); // asking what it cost buys nothing
  });

  it("costs nothing when it never reached a GPU, what it ran when it failed, and says so when it cannot be known", async () => {
    const never = new RunpodVideo(deps(new FakeRunpodApi(() => [{ status: "CANCELLED" }])), clipTarget);
    expect(await never.warmCost!(await never.warm!({ signal: signal() }), { timeoutMs: 60_000 })).toBe(0);
    const failed = new RunpodVideo(deps(new FakeRunpodApi(() => [{ status: "FAILED", error: "oom", executionTime: 20_000 }])), clipTarget);
    expect(await failed.warmCost!(await failed.warm!({ signal: signal() }), { timeoutMs: 60_000 })).toBe(0.0061);
    const api = new FakeRunpodApi(() => [{ status: "IN_QUEUE" }]);
    const gone = new RunpodVideo(deps(api), clipTarget);
    const id = await gone.warm!({ signal: signal() });
    await expect(gone.warmCost!(id, { timeoutMs: 5000 })).rejects.toThrow(/still IN_QUEUE/);
    api.expire(id);
    await expect(gone.warmCost!(id, { timeoutMs: 5000 })).rejects.toThrow(/no longer knows/);
  });
});

describe("the LTX clip worker (phase 15)", () => {
  const ltx = { endpointId: "ep-l", workflow: "clip-ltx25", version: 1 };
  const wan = { endpointId: "ep-c", workflow: "clip-wan22-480p", version: 1 };
  const signal = () => new AbortController().signal;
  async function pictures() {
    const dir = await tempDir();
    await makeImage(join(dir, "tall.png"), { width: 1088, height: 1920 });
    await makeImage(join(dir, "wide.png"), { width: 1920, height: 1088 });
    return { tall: join(dir, "tall.png"), wide: join(dir, "wide.png") };
  }

  it("offers no early start on the LTX worker, whose contract refuses one, and keeps Wan's", () => {
    const l = new RunpodVideo(deps(new FakeRunpodApi(() => [])), ltx);
    const w = new RunpodVideo(deps(new FakeRunpodApi(() => [])), wan);
    expect(typeof l.warm).toBe("undefined");
    expect(typeof l.warmCost).toBe("undefined");
    expect(typeof w.warm).toBe("function");
    expect(typeof w.warmCost).toBe("function");
  });

  it("asks for a 5.04 s portrait clip as the worker's contract says: 121 frames at 24 fps, 640x1152, the seed, and no speech unless asked", async () => {
    const { tall, wide } = await pictures();
    const video = new RunpodVideo(deps(new FakeRunpodApi(() => [])), ltx);
    const job = await video.prepare({ imagePath: tall, prompt: "A fox turns its head. Audio: wind.", durationSec: 121 / 24, height: 640, seed: 1234 });
    expect(job.input).toEqual({
      task: "clip",
      workflow: "clip-ltx25@1",
      image: (await readFile(tall)).toString("base64"),
      prompt: "A fox turns its head. Audio: wind.",
      frames: 121,
      fps: 24,
      width: 640,
      height: 1152,
      seed: 1234,
    });
    // on its side like its picture, the short side defaulting to the one LTX is made at
    expect((await video.prepare({ imagePath: wide, prompt: "p", durationSec: 49 / 24, seed: 0 })).input).toMatchObject({ frames: 49, width: 1152, height: 640 });
    // the words of the speech are asked for only for a scene that speaks
    expect((await video.prepare({ imagePath: tall, prompt: "p", durationSec: 121 / 24, seed: 1, speechLanguage: "tr" })).input).toMatchObject({ speech_language: "tr" });
  });

  it("refuses before anything is bought a length that is not 8k+1 frames from 49 to 361, a missing seed and any other size", async () => {
    const { tall } = await pictures();
    const video = new RunpodVideo(deps(new FakeRunpodApi(() => [])), ltx);
    const ask = (over: Partial<Parameters<typeof video.prepare>[0]>) => video.prepare({ imagePath: tall, prompt: "p", durationSec: 121 / 24, seed: 1, ...over });
    for (const durationSec of [5, 120 / 24, 41 / 24, 369 / 24]) {
      await expect(ask({ durationSec }), String(durationSec)).rejects.toBeInstanceOf(NonRetryableError);
      await expect(ask({ durationSec }), String(durationSec)).rejects.toThrow(/8k\+1 frames/);
    }
    expect((await ask({ durationSec: 361 / 24 })).input).toMatchObject({ frames: 361 });
    await expect(ask({ seed: undefined })).rejects.toThrow(/seed/);
    await expect(ask({ seed: -1 })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(ask({ seed: 1.5 })).rejects.toBeInstanceOf(NonRetryableError);
    for (const height of [480, 720, 1080]) {
      await expect(ask({ height }), String(height)).rejects.toBeInstanceOf(NonRetryableError);
      await expect(ask({ height }), String(height)).rejects.toThrow(/640/);
    }
  });

  it("asks Wan for exactly what it always did, field for field, whatever the new request fields say", async () => {
    const { tall } = await pictures();
    const video = new RunpodVideo(deps(new FakeRunpodApi(() => [])), wan);
    const before = { task: "clip", image: (await readFile(tall)).toString("base64"), prompt: "m", frames: 81, fps: 16, width: 480, height: 832, workflow: "clip-wan22-480p@1" };
    expect((await video.prepare({ imagePath: tall, prompt: "m", durationSec: 81 / 16 })).input).toEqual(before);
    expect((await video.prepare({ imagePath: tall, prompt: "m", durationSec: 81 / 16, seed: 9, speechLanguage: "en" })).input).toEqual(before);
    // and in the same order, which is what goes over the wire
    expect(Object.keys((await video.prepare({ imagePath: tall, prompt: "m", durationSec: 81 / 16 })).input)).toEqual(["task", "image", "prompt", "frames", "fps", "width", "height", "workflow"]);
  });

  it("gives an LTX job longer than Wan to run and to be waited for: its first job after a cold start loads about 68 GB", async () => {
    const api = new FakeRunpodApi(() => []);
    const l = new RunpodVideo(deps(api), ltx);
    const w = new RunpodVideo(deps(api), wan);
    await l.submit({ input: { task: "clip" } }, { signal: signal() });
    await w.submit({ input: { task: "clip" } }, { signal: signal() });
    expect(api.runs.map((r) => r.policy)).toEqual([{ executionTimeout: 1_200_000, ttl: 3_600_000 }, { executionTimeout: 600_000, ttl: 3_600_000 }]);
    expect([l.waitMs, w.waitMs]).toEqual([30 * 60_000, 20 * 60_000]);
  });

  async function collected(output: Record<string, unknown>, target = ltx) {
    const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output, executionTime: 100_000 }]);
    const video = new RunpodVideo(deps(api), target);
    const id = await video.submit({ input: {} }, { signal: signal() });
    return video.wait(id, { timeoutMs: 60_000 });
  }

  it("reads an LTX clip's frame rate, its sound and the words of its speech from the worker's answer", async () => {
    const words = [{ text: "Merhaba", start: 0.4, end: 0.9 }, { text: "dünya", start: 1, end: 1.5 }];
    const out = await collected({ url: "https://r2/c.mp4", seconds: 5.04, has_audio: true, words });
    expect(out).toMatchObject({ url: "https://r2/c.mp4", fps: 24, hasAudio: true, words, costUsd: 0.0306 });
    // a clip that was not asked for its words says so (none asked), not that it has none
    const silent = await collected({ url: "https://r2/c.mp4", seconds: 5.04, has_audio: false, words: null });
    expect(silent).toMatchObject({ fps: 24, hasAudio: false });
    expect(silent.words).toBeUndefined();
    expect((await collected({ url: "https://r2/c.mp4", seconds: 5.04, has_audio: true, words: [] })).words).toEqual([]);
    // a word said in an instant (a start equal to its end) is a word, not a malformed answer
    expect((await collected({ url: "https://r2/c.mp4", has_audio: true, words: [{ text: "a", start: 0, end: 0 }] })).words).toEqual([{ text: "a", start: 0, end: 0 }]);
  });

  it("returns none of the three for a Wan clip, whatever its answer carries", async () => {
    const out = await collected({ url: "https://r2/c.mp4", has_audio: true, words: [{ text: "x", start: 0, end: 1 }] }, wan);
    expect(out).not.toHaveProperty("fps");
    expect(out).not.toHaveProperty("hasAudio");
    expect(out).not.toHaveProperty("words");
  });

  it("refuses a malformed answer as paid for but unusable, with the job's cost", async () => {
    for (const bad of [
      { has_audio: "yes", words: [] },
      { has_audio: true, words: "hello" },
      { has_audio: true, words: [{ text: "a", start: 0 }] },
      { has_audio: true, words: [{ text: 1, start: 0, end: 1 }] },
      { has_audio: true, words: [{ text: "a", start: Number.NaN, end: 1 }] },
      // (times are caption timings: JSON has no NaN or Infinity, so a non-number, a negative time and an end before its start are what can arrive)
      { has_audio: true, words: [{ text: "a", start: "0", end: 1 }] },
      { has_audio: true, words: [{ text: "a", start: -0.1, end: 1 }] },
      { has_audio: true, words: [{ text: "a", start: 0, end: -1 }] },
      { has_audio: true, words: [{ text: "a", start: 1.2, end: 1.1 }] },
    ]) {
      const err = await collected({ url: "https://r2/c.mp4", ...bad }).catch((e: unknown) => e);
      expect(err, JSON.stringify(bad)).toBeInstanceOf(UnusableResultError);
      expect((err as UnusableResultError).costUsd).toBe(0.0306);
    }
  });

  it("recovers an LTX clip RunPod has forgotten without claiming to know its sound or its words: unknown is not none", async () => {
    const api = new FakeRunpodApi(() => [{ status: "COMPLETED" }]);
    const video = new RunpodVideo(deps(api, fakeR2(["flowchain/job-1.mp4"])), ltx);
    const id = await video.submit({ input: {} }, { signal: signal() });
    api.expire(id);
    const out = await video.wait(id, { timeoutMs: 60_000 });
    expect(out).toMatchObject({ url: "https://r2.example/flowchain/job-1.mp4?signed", fps: 24 });
    expect(out.hasAudio).toBeUndefined();
    expect(out.words).toBeUndefined();
    expect(out.words).not.toEqual([]);
  });
});

describe("what an LTX clip is charged (createProviders)", () => {
  const env = {
    GEMINI_API_KEY: "g", GEMINI_MODEL: "m", ELEVENLABS_MODEL: "eleven_multilingual_v2", FLOWCHAIN_BUDGET_USD: 3, FLOWCHAIN_VOICE: "narrator-m",
    FLOWCHAIN_CUT_REFERENCES: "off" as const, FLOWCHAIN_SMOOTH_MOTION: "off" as const, FLOWCHAIN_TREND_IDEAS: "off" as const, FLOWCHAIN_SCENE_SOUND: "off" as const,
    RUNS_DIR: "./runs", RUNPOD_API_KEY: "rk", R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s",
  };
  const ltxPrices = { runpodLtxUsdPerSec: 0.0011, runpodLtxSecPerClipSec: 30, runpodLtxColdStartSec: 120 };
  const models = (video: string) => ({ llm: "l", tts: "t", image: runpodModelId("ep-k", "keyframe-klein", 1), video });
  afterEach(() => vi.unstubAllGlobals());

  async function charged(video: string, prices: Prices) {
    const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output: { url: "https://r2/c.mp4", has_audio: true }, executionTime: 100_000 }]);
    vi.stubGlobal("fetch", api.fetch);
    const p = createProviders(env, models(video), prices);
    const id = await p.video.submit({ input: {} }, { signal: new AbortController().signal });
    return p.video.wait(id, { timeoutMs: 60_000 });
  }

  it("is the LTX card's own measured rate", async () => {
    expect((await charged(runpodModelId("ep-l", "clip-ltx25", 1), Prices.parse(ltxPrices))).costUsd).toBe(0.11); // 100 s x $0.0011/s
  });

  it("is still Wan's rate for a Wan clip, whether or not the LTX rates are set", async () => {
    expect((await charged(runpodModelId("ep-c", "clip-wan22-480p", 1), Prices.parse(ltxPrices))).costUsd).toBe(0.0306); // 100 s x $0.000306/s
    expect((await charged(runpodModelId("ep-c", "clip-wan22-480p", 1), Prices.parse({}))).costUsd).toBe(0.0306);
  });

  it("refuses to build the clip provider for an LTX run whose rates were removed from prices.json, rather than charge a guess", () => {
    const build = () => createProviders(env, models(runpodModelId("ep-l", "clip-ltx25", 1)), Prices.parse({}));
    expect(build).toThrow(NonRetryableError);
    expect(build).toThrow(LTX_RATES_MISSING);
  });
});
