import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
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
  }
}

const LTX_RATES = { runpodLtxUsdPerSec: 0.00016, runpodLtxSecPerClipSec: 29, runpodLtxColdStartSec: 120 };

describe("the run command's speech flags", () => {
  it("refuses --speech for a run whose clips are not made with LTX, before any run is made", async () => {
    const r = await run({ RUNPOD_CLIP_ENDPOINT: "ep-c", FLOWCHAIN_SPEECH: "on" }, undefined, "--speech");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/speaking character/);
    expect(r.runs).toEqual([]);
  });

  it("refuses --speech while the owner has not switched speech on, before any run is made", async () => {
    const r = await run({ RUNPOD_LTX_ENDPOINT: "ep-l" }, LTX_RATES, "--speech");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/speaking character/);
    expect(r.runs).toEqual([]);
  });

  it("refuses --speech while the LTX rates are missing, with the one refusal every part gives", async () => {
    const r = await run({ RUNPOD_LTX_ENDPOINT: "ep-l", FLOWCHAIN_SPEECH: "on" }, undefined, "--speech");
    expect(r.code).toBe(1);
    expect(r.out).toContain(LTX_RATES_MISSING);
    expect(r.runs).toEqual([]);
  });

  it("knows --no-speech, and does not take --speech and --no-speech as unknown options", async () => {
    // (both are refused for a reason of their own, never "unknown option": the run gets as far as its providers)
    for (const flag of ["--speech", "--no-speech"]) {
      const r = await run({}, undefined, flag);
      expect(r.out).not.toMatch(/unknown option/);
      expect(r.out).toMatch(/RUNPOD_CLIP_ENDPOINT not set/);
    }
  });
});
