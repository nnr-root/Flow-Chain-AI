import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyframeSize, loadEnv, loadPrices, outputSize } from "../../src/config.js";

const required = {
  GEMINI_API_KEY: "g",
  FAL_KEY: "f",
  ELEVENLABS_API_KEY: "e",
  ELEVENLABS_VOICE_ID: "v",
};

describe("loadEnv", () => {
  it("applies defaults for optional variables", () => {
    const env = loadEnv(required);
    expect(env.GEMINI_MODEL).toBe("gemini-flash-latest");
    expect(env.FAL_IMAGE_MODEL).toBe("fal-ai/flux/dev");
    expect(env.FAL_VIDEO_MODEL).toBe("fal-ai/kling-video/v2.1/standard/image-to-video");
    expect(env.ELEVENLABS_MODEL).toBe("eleven_multilingual_v2");
    expect(env.FLOWCHAIN_BUDGET_USD).toBe(3);
    expect(env.RUNS_DIR).toBe("./runs");
  });

  it("coerces the budget to a number", () => {
    expect(loadEnv({ ...required, FLOWCHAIN_BUDGET_USD: "7.5" }).FLOWCHAIN_BUDGET_USD).toBe(7.5);
  });

  it("names every missing required variable", () => {
    expect(() => loadEnv({ FAL_KEY: "f" })).toThrowError(/GEMINI_API_KEY[\s\S]*ELEVENLABS_API_KEY[\s\S]*ELEVENLABS_VOICE_ID/);
  });

  it("rejects empty keys", () => {
    expect(() => loadEnv({ ...required, FAL_KEY: "" })).toThrowError(/FAL_KEY/);
  });
});

describe("sizes", () => {
  it("maps aspect ratios to output and keyframe sizes", () => {
    expect(outputSize("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(outputSize("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(keyframeSize("9:16")).toEqual({ width: 1088, height: 1920 });
    expect(keyframeSize("16:9")).toEqual({ width: 1920, height: 1088 });
  });
});

describe("loadPrices", () => {
  it("rejects unknown keys and names the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-prices-"));
    const path = join(dir, "prices.json");
    await writeFile(path, JSON.stringify({ klingBase5s: 0.3, fluxPerMegaPixel: 0.02 }));
    expect(() => loadPrices(path)).toThrow(new RegExp(`${path}[\\s\\S]*fluxPerMegaPixel`));
  });

  it("names the file when it is not valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-prices-"));
    const path = join(dir, "prices.json");
    await writeFile(path, "{ nope");
    expect(() => loadPrices(path)).toThrow(path);
  });

  it("applies overrides from the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-prices-"));
    const path = join(dir, "prices.json");
    await writeFile(path, JSON.stringify({ klingBase5s: 0.3 }));
    expect(loadPrices(path).klingBase5s).toBe(0.3);
  });

  it("returns defaults when the file does not exist", () => {
    const p = loadPrices("/nonexistent/prices.json");
    expect(p).toEqual({
      fluxPerMegapixel: 0.025,
      klingBase5s: 0.25,
      klingPerExtraSec: 0.05,
      ttsPer1kChars: 0.3,
      llmPerMInputTokens: 0.3,
      llmPerMOutputTokens: 2.5,
    });
  });
});
