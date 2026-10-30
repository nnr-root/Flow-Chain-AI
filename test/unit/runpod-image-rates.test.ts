import { afterEach, describe, expect, it, vi } from "vitest";
import { Prices } from "../../src/config.js";
import { createProviders } from "../../src/providers/factory.js";
import { runpodModelId } from "../../src/providers/model-id.js";
import { FakeRunpodApi } from "../fakes/runpod.js";

const env = {
  GEMINI_API_KEY: "g",
  GEMINI_MODEL: "m",
  ELEVENLABS_MODEL: "eleven_multilingual_v2",
  FLOWCHAIN_BUDGET_USD: 3,
  FLOWCHAIN_VOICE: "narrator-m",
  FLOWCHAIN_CUT_REFERENCES: "off" as const,
  FLOWCHAIN_SMOOTH_MOTION: "off" as const,
  FLOWCHAIN_TREND_IDEAS: "off" as const,
  RUNS_DIR: "./runs",
  RUNPOD_API_KEY: "rk",
  R2_ACCOUNT_ID: "a",
  R2_BUCKET: "b",
  R2_ACCESS_KEY_ID: "i",
  R2_SECRET_ACCESS_KEY: "s",
};
const flux3Prices = Prices.parse({ runpodPicture3UsdPerSec: 0.0009, runpodPicture3Sec: 10, runpodPortrait3Sec: 12, runpodPicture3ColdStartSec: 60 });
const modelsFor = (image: string) => ({ llm: "l", tts: "t", image, video: runpodModelId("ep-c", "clip-wan22-480p", 1) });

afterEach(() => vi.unstubAllGlobals());

async function charged(image: string, prices: Prices) {
  const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output: { url: "https://r2/k.png", seed: 1 }, executionTime: 20_000 }]);
  vi.stubGlobal("fetch", api.fetch);
  const p = createProviders(env, modelsFor(image), prices);
  const id = await p.image.submit({ input: {} }, { signal: new AbortController().signal });
  const out = await p.image.wait(id, { timeoutMs: 60_000 });
  return { out, api };
}

describe("what a picture is charged", () => {
  it("charges a FLUX 3 picture at the 48 GB card's rate, not the 4090's", async () => {
    const { out } = await charged(runpodModelId("ep-3", "keyframe-flux3-klein", 1), flux3Prices);
    expect(out.costUsd).toBe(0.018); // 20 s x $0.0009/s
  });

  it("still charges a 4B picture at the 4090's rate when the FLUX 3 rates are set", async () => {
    const { out } = await charged(runpodModelId("ep-k", "keyframe-klein", 1), flux3Prices);
    expect(out.costUsd).toBe(0.0061); // 20 s x $0.000306/s = 0.00612
  });

  it("refuses to make a FLUX 3 picture of a run whose FLUX 3 rates were removed from prices.json", () => {
    expect(() => createProviders(env, modelsFor(runpodModelId("ep-3", "keyframe-flux3-klein", 1)), Prices.parse({}))).toThrow(/FLUX 3 picture rates are not set in prices\.json/);
  });

  it("gives a FLUX 3 job the longer execution limit and a 4B job the shorter one", async () => {
    const f3 = await charged(runpodModelId("ep-3", "keyframe-flux3-klein", 1), flux3Prices);
    const b4 = await charged(runpodModelId("ep-k", "keyframe-klein", 1), flux3Prices);
    expect(f3.api.runs[0].policy).toEqual({ executionTimeout: 300_000, ttl: 3_600_000 });
    expect(b4.api.runs[0].policy).toEqual({ executionTimeout: 120_000, ttl: 3_600_000 });
  });
});
