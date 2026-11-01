import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyframeSize, loadEnv, loadPrices, LTX_RATES_MISSING, ltxRates, outputSize, Prices } from "../../src/config.js";
import { RUNPOD_WORKFLOWS } from "../../src/providers/model-id.js";

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
    // the hosted voice's key is optional: without it new runs are spoken by the studio's own voice
    expect(loadEnv({ GEMINI_API_KEY: "g" }).ELEVENLABS_API_KEY).toBeUndefined();
    expect(loadEnv({ GEMINI_API_KEY: "g" }).ELEVENLABS_MODEL).toBe("eleven_v3");
    // the one voice id it was once given is not read at all: its voices are chosen per role and language now
    expect(loadEnv({ GEMINI_API_KEY: "g", ELEVENLABS_VOICE_ID: "old" })).not.toHaveProperty("ELEVENLABS_VOICE_ID");
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

describe("LTX settings", () => {
  const RATES = { runpodLtxUsdPerSec: 0.0005, runpodLtxSecPerClipSec: 12, runpodLtxColdStartSec: 120 };

  it("gives no LTX rates while any one of the three prices is missing, and all three when they are set", () => {
    expect(ltxRates(Prices.parse({}))).toBeUndefined();
    for (const key of Object.keys(RATES)) expect(ltxRates(Prices.parse({ ...RATES, [key]: undefined })), key).toBeUndefined();
    expect(ltxRates(Prices.parse(RATES))).toEqual({ usdPerSec: 0.0005, secPerClipSec: 12, coldStartSec: 120 });
  });

  it("refuses an LTX price that is zero or negative when prices.json is read, so no rate is ever a free clip", () => {
    for (const key of Object.keys(RATES)) {
      expect(() => Prices.parse({ ...RATES, [key]: 0 }), key).toThrow();
      expect(() => Prices.parse({ ...RATES, [key]: -1 }), key).toThrow();
    }
  });

  it("names the three keys in the one message the owner is given while the rates are missing", () => {
    expect(LTX_RATES_MISSING).toMatch(/^LTX clips are not set up: /);
    for (const key of Object.keys(RATES)) expect(LTX_RATES_MISSING).toContain(key);
  });

  it("has the LTX endpoint and the speech switch unset by default, and reads them when given", () => {
    const off = loadEnv(required);
    expect(off.RUNPOD_LTX_ENDPOINT).toBeUndefined();
    expect(off.FLOWCHAIN_SPEECH).toBeUndefined();
    const on = loadEnv({ ...required, RUNPOD_LTX_ENDPOINT: "lx1", FLOWCHAIN_SPEECH: "on" });
    expect(on.RUNPOD_LTX_ENDPOINT).toBe("lx1");
    expect(on.FLOWCHAIN_SPEECH).toBe("on");
    expect(() => loadEnv({ ...required, RUNPOD_LTX_ENDPOINT: "" })).toThrow();
  });

  it("has the owner's LTX switch off unless it says on, and refuses any other word", () => {
    expect(loadEnv(required).FLOWCHAIN_LTX).toBeUndefined();
    expect(loadEnv({ ...required, FLOWCHAIN_LTX: "on" }).FLOWCHAIN_LTX).toBe("on");
    expect(loadEnv({ ...required, FLOWCHAIN_LTX: "off" }).FLOWCHAIN_LTX).toBe("off");
    expect(() => loadEnv({ ...required, FLOWCHAIN_LTX: "yes" })).toThrow();
  });

  it("has a workflow id for the LTX clip beside Wan's", () => {
    expect(RUNPOD_WORKFLOWS.clipLtx).toEqual({ workflow: "clip-ltx25", version: 1 });
    expect(RUNPOD_WORKFLOWS.clip).toEqual({ workflow: "clip-wan22-480p", version: 1 });
  });
});
