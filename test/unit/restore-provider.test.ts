import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv, Prices, restoreRates, runpodRates } from "../../src/config.js";
import { createProviders } from "../../src/providers/factory.js";
import { RUNPOD_WORKFLOWS, runpodModelId } from "../../src/providers/model-id.js";
import { newRunRestore } from "../../src/providers/new-run.js";
import type { R2 } from "../../src/providers/r2.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { RunpodUpscale, type RunpodDeps } from "../../src/providers/runpod-providers.js";
import { FakeRunpodApi } from "../fakes/runpod.js";
import { tempDir } from "../helpers/media.js";

const rates = { runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 };
const env = loadEnv({
  GEMINI_API_KEY: "g", RUNPOD_API_KEY: "rk", RUNPOD_CLIP_ENDPOINT: "cl1", RUNPOD_KEYFRAME_ENDPOINT: "kf1", RUNPOD_UPSCALE_ENDPOINT: "up1",
  R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s",
});

afterEach(() => vi.unstubAllGlobals());

function deps(api: FakeRunpodApi): RunpodDeps {
  let t = 0;
  return { client: new RunpodClient("k", { fetch: api.fetch }), r2: {} as unknown as R2, rates: runpodRates(Prices.parse({})), poll: { pollMs: 1000, sleep: async (ms) => void (t += ms), now: () => t } };
}

describe("the smooth-motion rates", () => {
  it("cannot be priced until all four are in the price table", () => {
    expect(restoreRates(Prices.parse({}))).toBeNull();
    expect(restoreRates(Prices.parse({ ...rates, runpodRestoreExtraSecPerClipSec: undefined }))).toBeNull();
    expect(restoreRates(Prices.parse(rates))).toEqual({ usdPerSec: 0.0009, interpolateSecPerClipSec: 6, coldStartSec: 20, extraSecPerClipSec: 8 });
  });

  it("refuses zero and negative rates", () => {
    expect(() => Prices.parse({ ...rates, runpodInterpolateUsdPerSec: 0 })).toThrow();
    expect(() => Prices.parse({ ...rates, runpodRestoreExtraSecPerClipSec: -1 })).toThrow();
  });
});

describe("the model a 60 fps run freezes", () => {
  it("is the restorer's new workflow on the restorer endpoint, whether or not the run is Full HD", () => {
    const p = Prices.parse(rates);
    expect(newRunRestore(env, p)).toBe("runpod:up1/restore-video@1");
    expect(newRunRestore(env, p)).toBe("runpod:up1/restore-video@1");
    expect(RUNPOD_WORKFLOWS.restore).toEqual({ workflow: "restore-video", version: 1 });
  });

  it("refuses plainly while the rates or the endpoint are missing", () => {
    expect(() => newRunRestore(env, Prices.parse({}))).toThrow(/smooth motion is not set up/);
    expect(() => newRunRestore(loadEnv({ GEMINI_API_KEY: "k" }), Prices.parse(rates))).toThrow(/RUNPOD_UPSCALE_ENDPOINT/);
  });
});

describe("the request the restorer is sent", () => {
  it("carries only the steps asked for, and the old request is exactly what it was", async () => {
    const dir = await tempDir();
    const clip = join(dir, "clip.mp4");
    await writeFile(clip, Buffer.from("mp4-bytes"));
    const video = Buffer.from("mp4-bytes").toString("base64");
    const restore = new RunpodUpscale(deps(new FakeRunpodApi(() => [])), { endpointId: "up1", workflow: "restore-video", version: 1 });
    expect((await restore.prepare({ videoPath: clip, short: 1080 })).input).toEqual({ task: "upscale", video, short: 1080, workflow: "restore-video@1" });
    expect((await restore.prepare({ videoPath: clip, interpolate: 2 })).input).toEqual({ task: "upscale", video, interpolate: 2, workflow: "restore-video@1" });
    expect((await restore.prepare({ videoPath: clip, short: 1080, interpolate: 2 })).input).toEqual({ task: "upscale", video, short: 1080, interpolate: 2, workflow: "restore-video@1" });
    const old = new RunpodUpscale(deps(new FakeRunpodApi(() => [])), { endpointId: "up1", workflow: "upscale-seedvr2", version: 1 });
    expect((await old.prepare({ videoPath: clip, short: 1080 })).input).toEqual({ task: "upscale", video, short: 1080, workflow: "upscale-seedvr2@1" });
  });
});

const modelsFor = (upscale: string) => ({ llm: "l", tts: "t", image: runpodModelId("ep-k", "keyframe-klein", 1), video: runpodModelId("ep-c", "clip-wan22-480p", 1), upscale });

async function charged(upscale: string, prices: Prices) {
  const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output: { url: "https://r2/k.mp4" }, executionTime: 20_000 }]);
  vi.stubGlobal("fetch", api.fetch);
  const p = createProviders(env, modelsFor(upscale), prices);
  const id = await p.upscale!.submit({ input: {} }, { signal: new AbortController().signal });
  return p.upscale!.wait(id, { timeoutMs: 60_000 });
}

describe("what a restorer job is charged", () => {
  it("is the restorer's own rate for the new workflow", async () => {
    const out = await charged(runpodModelId("up1", "restore-video", 1), Prices.parse(rates));
    expect(out.costUsd).toBe(0.018); // 20 s x $0.0009/s
  });

  it("is still the old Full HD rate for the old workflow, whether or not the smooth-motion rates are set", async () => {
    expect((await charged(runpodModelId("up1", "upscale-seedvr2", 1), Prices.parse(rates))).costUsd).toBe(0.0061); // 20 s x $0.000306/s = 0.00612
    expect((await charged(runpodModelId("up1", "upscale-seedvr2", 1), Prices.parse({}))).costUsd).toBe(0.0061);
  });

  it("refuses to build the restorer for a run whose smooth-motion rates were removed from prices.json", () => {
    expect(() => createProviders(env, modelsFor(runpodModelId("up1", "restore-video", 1)), Prices.parse({}))).toThrow(/smooth motion is not set up/);
  });
});
