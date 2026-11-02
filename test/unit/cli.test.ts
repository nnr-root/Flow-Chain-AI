import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LTX_RATES_MISSING } from "../../src/config.js";

const exec = promisify(execFile);
const CLI = resolve("src/cli.ts");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/**
 * The real CLI's `run`, started in an empty folder of its own: no `.env` and no `prices.json` but the ones a case writes,
 * and an environment of stand-in names only. Every case here is refused before the doctor or any provider is reached.
 */
async function run(env: Record<string, string>, prices?: object, ...args: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "fc-cli-"));
  if (prices) await writeFile(join(cwd, "prices.json"), JSON.stringify(prices));
  const runs = join(cwd, "runs");
  const base = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", RUNS_DIR: runs, GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_VOICE_ENDPOINT: "ep-v" };
  try {
    const { stdout, stderr } = await exec("node", ["--import", TSX, CLI, "run", "--topic", "foxes", "--yes", ...args], { cwd, env: { ...base, ...env }, timeout: 60_000 });
    return { code: 0, out: stdout + stderr, runs: await readdir(runs).catch(() => []) };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, out: (err.stdout ?? "") + (err.stderr ?? ""), runs: await readdir(runs).catch(() => []) };
  } finally {
    // (what the folder held is read above; left behind, every run of this file adds one to the system's temp folder)
    await rm(cwd, { recursive: true, force: true });
  }
}

const LTX_RATES = { runpodLtxUsdPerSec: 0.00016, runpodLtxSecPerClipSec: 29, runpodLtxColdStartSec: 120 };

const CLIPS_UNAVAILABLE = "moving clips are not available in this studio right now";

describe("the run command's speech flags", () => {
  const NOT_HERE = "speaking characters are not available in this studio";

  it("refuses --speech for a run of pictures only made without a clip engine, before any run is made", async () => {
    for (const pictures of [["--mode", "2"], ["--pin-modes", "2"]]) {
      const r = await run({ FLOWCHAIN_SPEECH: "on" }, undefined, ...pictures, "--speech", "--language", "en");
      expect(r.code).toBe(1);
      expect(r.out).toContain(NOT_HERE);
      // (refused for its speech: a run of pictures needs no clip engine)
      expect(r.out).not.toContain(CLIPS_UNAVAILABLE);
      expect(r.runs).toEqual([]);
    }
  });

  it("refuses --speech while the owner has not switched speech on, before any run is made", async () => {
    const r = await run({ RUNPOD_LTX_ENDPOINT: "ep-l", FLOWCHAIN_LTX: "on" }, LTX_RATES, "--speech", "--language", "en");
    expect(r.code).toBe(1);
    expect(r.out).toContain(NOT_HERE);
    expect(r.runs).toEqual([]);
  });

  it("refuses --speech while the LTX rates are missing, in the same sentence, and not as a refusal of every run", async () => {
    const r = await run({ RUNPOD_LTX_ENDPOINT: "ep-l", FLOWCHAIN_LTX: "on", FLOWCHAIN_SPEECH: "on" }, undefined, "--mode", "2", "--speech", "--language", "en");
    expect(r.code).toBe(1);
    expect(r.out).toContain(NOT_HERE);
    expect(r.out).not.toContain(LTX_RATES_MISSING);
    expect(r.runs).toEqual([]);
  });

  it("refuses --speech while the owner has not switched LTX on, though its endpoint and rates are set, before any run is made", async () => {
    const r = await run({ RUNPOD_LTX_ENDPOINT: "ep-l", FLOWCHAIN_SPEECH: "on" }, LTX_RATES, "--mode", "2", "--speech", "--language", "en");
    expect(r.code).toBe(1);
    expect(r.out).toContain(NOT_HERE);
    expect(r.runs).toEqual([]);
  });

  it("refuses --speech in a language speech was not measured in, before any run is made", async () => {
    const r = await run({ RUNPOD_LTX_ENDPOINT: "ep-l", FLOWCHAIN_LTX: "on", FLOWCHAIN_SPEECH: "on" }, LTX_RATES, "--speech", "--language", "ja");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/a character can speak only in a video in English or Turkish/);
    expect(r.runs).toEqual([]);
  });

  it("knows --no-speech, and does not take --speech and --no-speech as unknown options", async () => {
    // (both are refused for a reason of their own, never "unknown option": the run gets as far as its providers)
    for (const flag of ["--speech", "--no-speech"]) {
      const r = await run({}, undefined, flag);
      expect(r.out).not.toMatch(/unknown option/);
      expect(r.out).toContain(CLIPS_UNAVAILABLE);
    }
  });
});

describe("the run command without Wan", () => {
  it("refuses a run that may need a moving clip without the clip engine, in one plain sentence, before any run is made", async () => {
    // (an older .env's Wan clip endpoint makes no clip any more)
    const envs: Array<Record<string, string>> = [{}, { RUNPOD_CLIP_ENDPOINT: "ep-c" }, { RUNPOD_LTX_ENDPOINT: "ep-l", RUNPOD_CLIP_ENDPOINT: "ep-c" }];
    for (const env of envs) {
      for (const modes of [[], ["--mode", "1"], ["--modes", "2,1,2,2"], ["--pin-modes", "2,auto,2,2"]]) {
        const r = await run(env, LTX_RATES, ...modes);
        expect(r.code, `${JSON.stringify(env)} ${modes.join(" ")}`).toBe(1);
        expect(r.out).toContain(CLIPS_UNAVAILABLE);
        expect(r.runs).toEqual([]);
      }
    }
  });

  it("no longer knows --clips: the clip size is not a choice", async () => {
    for (const quality of ["480p", "720p"]) {
      const r = await run({ RUNPOD_LTX_ENDPOINT: "ep-l", FLOWCHAIN_LTX: "on" }, LTX_RATES, "--clips", quality);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/unknown option '--clips'/);
      expect(r.runs).toEqual([]);
    }
  });
});
