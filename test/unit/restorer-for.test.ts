import { describe, expect, it } from "vitest";
import { loadEnv, Prices } from "../../src/config.js";
import { restorerFor } from "../../src/providers/new-run.js";

const env = loadEnv({ GEMINI_API_KEY: "g", RUNPOD_UPSCALE_ENDPOINT: "up1" });
const prices = Prices.parse({ runpodInterpolateUsdPerSec: 0.0009, runpodInterpolateSecPerClipSec: 6, runpodInterpolateColdStartSec: 20, runpodRestoreExtraSecPerClipSec: 8 });

describe("the restorer model a run freezes", () => {
  it("is none for a run that asked for neither", () => {
    expect(restorerFor({}, env, prices)).toBeUndefined();
  });

  it("is the old Full HD workflow for Full HD alone, and needs no smooth-motion rates, so its jobs and keys are unchanged", () => {
    expect(restorerFor({ upscale: true }, env, Prices.parse({}))).toBe("runpod:up1/upscale-seedvr2@1");
  });

  it("is the restorer's new workflow for smooth motion, with or without Full HD", () => {
    expect(restorerFor({ fps: "60" }, env, prices)).toBe("runpod:up1/restore-video@1");
    expect(restorerFor({ fps: "60", upscale: true }, env, prices)).toBe("runpod:up1/restore-video@1");
  });

  it("refuses smooth motion plainly while the rates are missing, before anything is bought", () => {
    expect(() => restorerFor({ fps: "60" }, env, Prices.parse({}))).toThrow(/smooth motion is not set up/);
  });
});
