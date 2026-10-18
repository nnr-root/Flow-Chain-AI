import { describe, expect, it } from "vitest";
import { Prices, flux3Rates, loadEnv } from "../../src/config.js";
import { IMAGE_PROFILES, imageProfileOf, takesReference, takesSeveralReferences } from "../../src/image-profiles.js";
import { newRunProviders } from "../../src/providers/new-run.js";

const rates = { runpodPicture3UsdPerSec: 0.0006, runpodPicture3Sec: 24, runpodPortrait3Sec: 12, runpodPicture3ColdStartSec: 90 };
const base = { GEMINI_API_KEY: "k", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "kf1", RUNPOD_CLIP_ENDPOINT: "cl1" };

describe("the FLUX 3 picture profile", () => {
  it("cannot be priced until all four rates are in the price table", () => {
    expect(flux3Rates(Prices.parse({}))).toBeNull();
    expect(flux3Rates(Prices.parse({ ...rates, runpodPicture3Sec: undefined }))).toBeNull();
    expect(flux3Rates(Prices.parse(rates))).toEqual({ usdPerSec: 0.0006, pictureSec: 24, portraitSec: 12, coldStartSec: 90 });
    expect(() => IMAGE_PROFILES["runpod-flux3-klein@1"].keyframeUsd(Prices.parse({}), { width: 1088, height: 1920 })).toThrow(/rates are not set/);
  });

  it("prices a picture, a portrait and a start from the measured seconds", () => {
    const p = Prices.parse(rates);
    const profile = imageProfileOf("runpod-flux3-klein@1");
    expect(profile.keyframeUsd(p, { width: 1088, height: 1920 })).toBeCloseTo(24 * 0.0006, 4);
    expect(profile.referenceUsd(p, { width: 1024, height: 1024 })).toBeCloseTo(12 * 0.0006, 4);
    expect(profile.runOverheadUsd(p)).toBeCloseTo(90 * 0.0006, 4);
  });

  it("takes a portrait like the 4B, and several references only itself", () => {
    expect(takesReference("runpod-flux3-klein@1")).toBe(true);
    expect(takesSeveralReferences("runpod-flux3-klein@1")).toBe(true);
    expect(takesSeveralReferences("runpod-klein@1")).toBe(false);
    expect(takesSeveralReferences(undefined)).toBe(false);
  });
});

describe("the picture model a new run is made with", () => {
  const ready = loadEnv({ ...base, RUNPOD_PICTURE3_ENDPOINT: "f3x" });
  const p = Prices.parse(rates);

  it("is the 4B klein while the new one is not set up", () => {
    expect(newRunProviders(loadEnv(base), "480p", p).imageProfile).toBe("runpod-klein@1");
    expect(newRunProviders(ready, "480p", Prices.parse({})).imageProfile).toBe("runpod-klein@1");
    expect(newRunProviders(ready, "480p").imageProfile).toBe("runpod-klein@1");
  });

  it("is FLUX 3 klein when its endpoint and rates are both set, on that endpoint", () => {
    const chosen = newRunProviders(ready, "480p", p);
    expect(chosen.imageProfile).toBe("runpod-flux3-klein@1");
    expect(chosen.image).toBe("runpod:f3x/keyframe-flux3-klein@1");
  });

  it("is the 4B again when the owner says so, whatever else is set", () => {
    const forced = loadEnv({ ...base, RUNPOD_PICTURE3_ENDPOINT: "f3x", FLOWCHAIN_IMAGE_MODEL: "klein4b" });
    expect(newRunProviders(forced, "480p", p).imageProfile).toBe("runpod-klein@1");
  });

  it("refuses to start a run when the owner insists on FLUX 3 and it is not ready", () => {
    const insist = loadEnv({ ...base, FLOWCHAIN_IMAGE_MODEL: "flux3" });
    expect(() => newRunProviders(insist, "480p", p)).toThrow(/FLOWCHAIN_IMAGE_MODEL=flux3/);
  });

  it("does not need the 4B endpoint when it makes the pictures on FLUX 3", () => {
    const { RUNPOD_KEYFRAME_ENDPOINT: _gone, ...without } = base;
    expect(newRunProviders(loadEnv({ ...without, RUNPOD_PICTURE3_ENDPOINT: "f3x" }), "480p", p).imageProfile).toBe("runpod-flux3-klein@1");
  });
});

describe("the cut references setting", () => {
  it("is off unless the owner turns it on", () => {
    expect(loadEnv(base).FLOWCHAIN_CUT_REFERENCES).toBe("off");
    expect(loadEnv({ ...base, FLOWCHAIN_CUT_REFERENCES: "on" }).FLOWCHAIN_CUT_REFERENCES).toBe("on");
  });
});
