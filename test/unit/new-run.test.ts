import { describe, expect, it } from "vitest";
import { loadEnv, Prices } from "../../src/config.js";
import { checkR2RoundTrip, checkRunpodEndpoints, usesGpu } from "../../src/doctor.js";
import { frozenModePrices, newRunImage, newRunProviders, newRunSpeech, onlyPictures, SPEECH_REQUEST } from "../../src/providers/new-run.js";
import { NO_CLIPS_MODEL, parseModelId } from "../../src/providers/model-id.js";
import { RunRequest } from "../../src/manifest/schema.js";
import type { R2 } from "../../src/providers/r2.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { FakeRunpodApi } from "../fakes/runpod.js";

const base = {
  GEMINI_API_KEY: "g",
};

describe("newRunProviders", () => {
  const rates = Prices.parse({ runpodLtxUsdPerSec: 0.00016, runpodLtxSecPerClipSec: 29, runpodLtxColdStartSec: 120 });
  const withLtx = { ...base, RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_LTX_ENDPOINT: "ep-l", FLOWCHAIN_LTX: "on" };
  const CLIPS_UNAVAILABLE = "moving clips are not available in this studio right now";

  it("freezes the picture endpoint and LTX, the only clip engine, when the owner switched it on and its endpoint and rates are set", () => {
    expect(newRunProviders(loadEnv(withLtx), rates)).toEqual({
      image: "runpod:ep-k/keyframe-klein@1",
      video: "runpod:ep-l/clip-ltx25@1",
      imageProfile: "runpod-klein@1",
      videoProfile: "ltx25@1",
    });
    // (a run of pictures made where clips can be made is frozen with them, so its draft may still be given a clip)
    expect(newRunProviders(loadEnv(withLtx), rates, true).video).toBe("runpod:ep-l/clip-ltx25@1");
  });

  it("refuses a run that may need a moving clip in one plain sentence while LTX is off, without its endpoint or with a rate missing", () => {
    const partial = Prices.parse({ runpodLtxUsdPerSec: 0.00016, runpodLtxSecPerClipSec: 29 });
    const cases: Array<[Record<string, string | undefined>, Prices | undefined]> = [
      [{ ...withLtx, FLOWCHAIN_LTX: undefined }, rates],
      [{ ...withLtx, FLOWCHAIN_LTX: "off" }, rates],
      [{ ...withLtx, RUNPOD_LTX_ENDPOINT: undefined }, rates],
      [withLtx, partial],
      [withLtx, Prices.parse({})],
      [withLtx, undefined],
      // (an older .env's Wan clip endpoint makes no clip any more)
      [{ ...base, RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c" }, rates],
    ];
    for (const [env, prices] of cases) expect(() => newRunProviders(loadEnv(env), prices)).toThrow(CLIPS_UNAVAILABLE);
  });

  it("names no model, setting or provider in that sentence, since it reaches a customer's job log", () => {
    expect(() => newRunProviders(loadEnv(base), rates)).toThrow(CLIPS_UNAVAILABLE);
    expect(CLIPS_UNAVAILABLE).not.toMatch(/ltx|wan|runpod|FLOWCHAIN|endpoint|price/i);
  });

  it("makes a run of pictures only without any clip setting, with a clip model that refuses only if a clip is asked of it", () => {
    const env = loadEnv({ ...base, RUNPOD_KEYFRAME_ENDPOINT: "ep-k" });
    expect(newRunProviders(env, Prices.parse({}), true)).toEqual({
      image: "runpod:ep-k/keyframe-klein@1",
      video: NO_CLIPS_MODEL,
      imageProfile: "runpod-klein@1",
      videoProfile: "ltx25@1",
    });
    expect(parseModelId(NO_CLIPS_MODEL).provider).toBe("retired");
  });

  it("still asks for a deploy when there is no picture endpoint", () => {
    expect(() => newRunProviders(loadEnv(base), Prices.parse({}), true)).toThrow("RUNPOD_KEYFRAME_ENDPOINT not set; run npm run runpod:deploy first");
  });
});

describe("onlyPictures", () => {
  it("is true for a run whose every scene is a picture, by its modes or by every scene pinned to one", () => {
    expect(onlyPictures([2, 2, 2], undefined)).toBe(true);
    expect(onlyPictures(undefined, [2, 2])).toBe(true);
    expect(onlyPictures(undefined, [2])).toBe(true);
  });

  it("is false for an auto run, a run with any clip, and a run with any scene left to the rules", () => {
    expect(onlyPictures(undefined, undefined)).toBe(false);
    expect(onlyPictures([2, 1, 2], undefined)).toBe(false);
    expect(onlyPictures([1, 1], undefined)).toBe(false);
    expect(onlyPictures(undefined, [2, null])).toBe(false);
    expect(onlyPictures(undefined, [1])).toBe(false);
    expect(onlyPictures([], undefined)).toBe(false);
  });
});

describe("newRunSpeech", () => {
  const on = loadEnv({ ...base, FLOWCHAIN_SPEECH: "on" });
  const NOT_HERE = "speaking characters are not available in this studio";

  it("is off, and says nothing, when the run did not ask for it, on any clip profile or language", () => {
    for (const env of [loadEnv(base), on]) {
      for (const profile of ["ltx25@1", "wan22-480p@1"] as const) {
        for (const language of ["en", "ja", undefined]) {
          expect(newRunSpeech(env, profile, undefined, language)).toBe(false);
          expect(newRunSpeech(env, profile, false, language)).toBe(false);
        }
      }
    }
  });

  it("is on only for a run whose clips are made with LTX while the owner switched speech on, in a language speech was measured in", () => {
    expect(newRunSpeech(on, "ltx25@1", true, "en")).toBe(true);
    expect(newRunSpeech(on, "ltx25@1", true, "tr")).toBe(true);
  });

  it("refuses a speaking character on any other clip profile, or in a run with no clip engine, in one plain sentence", () => {
    for (const profile of ["wan22-480p@1", "wan22-720p@1", "kling-v2", undefined] as const) {
      expect(() => newRunSpeech(on, profile, true, "en")).toThrow(NOT_HERE);
    }
  });

  it("refuses a speaking character while the owner has not switched speech on, in the same sentence", () => {
    for (const env of [loadEnv(base), loadEnv({ ...base, FLOWCHAIN_SPEECH: "off" })]) {
      expect(() => newRunSpeech(env, "ltx25@1", true, "en")).toThrow(NOT_HERE);
    }
  });

  it("refuses a speaking character in a language speech was not measured in, or with no language given, plainly", () => {
    for (const language of ["ja", "de", "ar", undefined]) {
      expect(() => newRunSpeech(on, "ltx25@1", true, language)).toThrow(/a character can speak only in a video in English or Turkish/);
    }
  });

  it("names no model and no setting in any refusal, since the words reach a customer's job log", () => {
    const refusals = [() => newRunSpeech(on, "wan22-480p@1", true, "en"), () => newRunSpeech(loadEnv(base), "ltx25@1", true, "en"), () => newRunSpeech(on, "ltx25@1", true, "ja")];
    for (const refuse of refusals) expect(refuse).not.toThrow(/ltx|lightricks|wan|FLOWCHAIN|RUNPOD|price/i);
  });
});

describe("newRunImage", () => {
  const flux3 = Prices.parse({ runpodPicture3UsdPerSec: 0.0003, runpodPicture3Sec: 6, runpodPortrait3Sec: 8, runpodPicture3ColdStartSec: 60 });

  it("picks the 4B on its keyframe endpoint when FLUX 3 is not set up", () => {
    expect(newRunImage(loadEnv({ ...base, RUNPOD_KEYFRAME_ENDPOINT: "ep-k" }))).toEqual({ image: "runpod:ep-k/keyframe-klein@1", imageProfile: "runpod-klein@1" });
  });

  it("asks for a deploy when there is no keyframe endpoint and FLUX 3 is not ready", () => {
    expect(() => newRunImage(loadEnv(base))).toThrow("RUNPOD_KEYFRAME_ENDPOINT not set; run npm run runpod:deploy first");
  });

  it("refuses when FLUX 3 is forced and not set up", () => {
    expect(() => newRunImage(loadEnv({ ...base, FLOWCHAIN_IMAGE_MODEL: "flux3", RUNPOD_KEYFRAME_ENDPOINT: "ep-k" }))).toThrow("FLOWCHAIN_IMAGE_MODEL=flux3 but FLUX 3 is not set up");
  });

  it("does not need any clip setting, which a picture-only tool never uses", () => {
    const env = loadEnv({ ...base, RUNPOD_KEYFRAME_ENDPOINT: "ep-k" });
    expect(newRunImage(env)).toEqual({ image: "runpod:ep-k/keyframe-klein@1", imageProfile: "runpod-klein@1" });
    // (while a new run that may need a clip is refused there)
    expect(() => newRunProviders(env)).toThrow("moving clips are not available in this studio right now");
  });

  it("keeps the 4B when klein4b is forced, and takes FLUX 3 when it is ready", () => {
    const env = { ...base, RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_PICTURE3_ENDPOINT: "ep-p" };
    expect(newRunImage(loadEnv(env), flux3).imageProfile).toBe("runpod-flux3-klein@1");
    expect(newRunImage(loadEnv({ ...env, FLOWCHAIN_IMAGE_MODEL: "klein4b" }), flux3).imageProfile).toBe("runpod-klein@1");
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
      runpodColdStartSec: 90,
    });
    // (Wan's seconds a frame is no longer frozen into a new run's table: no new run has a Wan clip)
    expect(frozen.runpodClipSecPerFrame).toBeUndefined();
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

describe("what a run that lets a character speak is frozen with", () => {
  it("is speech, and speaking clips as long as their sentences", () => {
    expect(SPEECH_REQUEST).toEqual({ speech: true, speakingClip: "sentence" });
    expect(RunRequest.shape.speakingClip.parse(SPEECH_REQUEST.speakingClip)).toBe("sentence");
  });
});
