import { describe, expect, it } from "vitest";
import { loadEnv, LTX_RATES_MISSING, Prices } from "../../src/config.js";
import { checkR2RoundTrip, checkRunpodEndpoints, usesGpu } from "../../src/doctor.js";
import { frozenModePrices, newRunProviders } from "../../src/providers/new-run.js";
import type { R2 } from "../../src/providers/r2.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { FakeRunpodApi } from "../fakes/runpod.js";

const base = {
  GEMINI_API_KEY: "g",
};

describe("newRunProviders", () => {
  it("freezes the RunPod endpoints and worker versions with the RunPod profiles", () => {
    const env = loadEnv({ ...base, RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c" });
    expect(newRunProviders(env)).toEqual({
      image: "runpod:ep-k/keyframe-klein@1",
      video: "runpod:ep-c/clip-wan22-480p@1",
      imageProfile: "runpod-klein@1",
      videoProfile: "wan22-480p@1",
    });
  });

  it("freezes the clip size the run asked for: 480p unless it says 720p", () => {
    const env = loadEnv({ ...base, RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c" });
    expect(newRunProviders(env).videoProfile).toBe("wan22-480p@1");
    expect(newRunProviders(env, "720p")).toMatchObject({ videoProfile: "wan22-720p@1", video: "runpod:ep-c/clip-wan22-480p@1" });
  });

  describe("with the LTX endpoint", () => {
    const rates = Prices.parse({ runpodLtxUsdPerSec: 0.00016, runpodLtxSecPerClipSec: 29, runpodLtxColdStartSec: 120 });
    const withLtx = { ...base, RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_LTX_ENDPOINT: "ep-l" };

    it("freezes ltx25@1 and needs no Wan endpoint, whatever clip size was asked for", () => {
      const env = loadEnv(withLtx);
      for (const q of ["480p", "720p"] as const) {
        expect(newRunProviders(env, q, rates)).toMatchObject({ videoProfile: "ltx25@1", video: "runpod:ep-l/clip-ltx25@1" });
      }
    });

    it("says why when the endpoint is set but a rate is not, instead of falling back to Wan", () => {
      const env = loadEnv({ ...withLtx, RUNPOD_CLIP_ENDPOINT: "ep-c" });
      expect(() => newRunProviders(env, "480p", Prices.parse({}))).toThrow(LTX_RATES_MISSING);
      expect(() => newRunProviders(env)).toThrow(LTX_RATES_MISSING);
    });
  });

  it("asks for a deploy when the endpoints are not configured", () => {
    expect(() => newRunProviders(loadEnv(base))).toThrow(
      "RUNPOD_KEYFRAME_ENDPOINT and RUNPOD_CLIP_ENDPOINT not set; run npm run runpod:deploy first",
    );
  });
});

describe("checkR2RoundTrip cleanup", () => {
  it("deletes its probe object even when reading it back throws", async () => {
    const store = new Map<string, string>();
    const r2 = {
      put: async (k: string, v: string) => void store.set(k, v),
      get: async () => {
        throw new Error("get failed");
      },
      delete: async (k: string) => void store.delete(k),
    } as unknown as R2;
    await expect(checkR2RoundTrip(r2)).rejects.toThrow("get failed");
    expect(store.size).toBe(0);
  });
});

describe("frozenModePrices", () => {
  it("freezes the materialised RunPod rates into a RunPod run's table, keeping overrides", () => {
    const frozen = frozenModePrices(Prices.parse({ runpodClipUsdPerSec: 0.0009, klingBase5s: 0.3 }));
    expect(frozen).toMatchObject({
      klingBase5s: 0.3,
      runpodKeyframeUsdPerSec: 0.000306,
      runpodClipUsdPerSec: 0.0009,
      runpodKeyframeSec: 8,
      runpodReferenceSec: 8,
      runpodClipSecPerFrame: 1.0,
      runpodColdStartSec: 90,
    });
    expect(Prices.parse(frozen)).toEqual(frozen);
  });
});

describe("doctor for RunPod", () => {
  it("checks the GPU endpoints for a new run and for a run made on them, and not for a run made on a hosted model", () => {
    expect(usesGpu()).toBe(true);
    expect(usesGpu({ llm: "l", tts: "t", image: "runpod:ep-k/keyframe-sdxl@1", video: "runpod:ep-c/clip-wan22-480p@1" })).toBe(true);
    expect(usesGpu({ llm: "l", tts: "t", image: "fal-ai/flux/dev", video: "fal-ai/kling" })).toBe(false);
  });

  it("asks each endpoint for its health without buying a job", async () => {
    const api = new FakeRunpodApi(() => []);
    expect(await checkRunpodEndpoints(new RunpodClient("k", { fetch: api.fetch }), ["ep-k", "ep-c"])).toBe(
      "2 endpoint(s) healthy",
    );
    expect(api.runs).toHaveLength(0);
  });

  it("round-trips a tiny object through the bucket and cleans it up", async () => {
    const store = new Map<string, string>();
    const r2 = {
      put: async (k: string, v: string) => void store.set(k, v),
      get: async (k: string) => store.get(k) ?? "",
      delete: async (k: string) => void store.delete(k),
    } as unknown as R2;
    expect(await checkR2RoundTrip(r2)).toBe("put, get and delete work");
    expect(store.size).toBe(0);
  });
});
