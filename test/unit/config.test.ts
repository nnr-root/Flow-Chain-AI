import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyframeSize, loadEnv, loadPrices, outputSize } from "../../src/config.js";

const required = {
  GEMINI_API_KEY: "g",
};

describe("loadEnv", () => {
  it("applies defaults for optional variables", () => {
    const env = loadEnv(required);
    expect(env.GEMINI_MODEL).toBe("gemini-flash-latest");
    expect(env.FLOWCHAIN_VOICE).toBe("narrator-m");
    expect(env.FLOWCHAIN_BUDGET_USD).toBe(3);
    expect(env.RUNS_DIR).toBe("./runs");
  });

  it("coerces the budget to a number", () => {
    expect(loadEnv({ ...required, FLOWCHAIN_BUDGET_USD: "7.5" }).FLOWCHAIN_BUDGET_USD).toBe(7.5);
  });

  it("names every missing required variable", () => {
    expect(() => loadEnv({ RUNS_DIR: "./r" })).toThrowError(/GEMINI_API_KEY/);
    // a key of the hosted voice the studio stopped using is not read at all, wherever it is still written
    expect(loadEnv({ GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "old" })).not.toHaveProperty("ELEVENLABS_API_KEY");
  });

  it("rejects empty keys", () => {
    expect(() => loadEnv({ ...required, RUNPOD_API_KEY: "" })).toThrowError(/RUNPOD_API_KEY/);
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
