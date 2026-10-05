import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { fileSha256, inputHash, sha256, stableStringify } from "../../src/manifest/hash.js";
import { Manifest } from "../../src/manifest/schema.js";
import { createManifest, loadManifest, newRunId, resolveModes, resolveShots, saveManifest } from "../../src/manifest/store.js";

const request = { topic: "foxes", aspect: "9:16" as const, sceneCount: 2, modes: [1, 2] as (1 | 2)[], voiceId: "v1" };
const models = { llm: "l", tts: "t", image: "i", video: "v" };

describe("hash", () => {
  it("stableStringify ignores key order and undefined values", () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe(stableStringify({ a: [1, { d: 2 }], b: 1 }));
    expect(stableStringify({ a: 1 })).toBe('{"a":1}');
  });

  it("inputHash is deterministic and sensitive to stage and inputs", () => {
    const a = inputHash("tts", { text: "hi", nonce: 0 });
    expect(inputHash("tts", { nonce: 0, text: "hi" })).toBe(a);
    expect(inputHash("tts", { text: "hi", nonce: 1 })).not.toBe(a);
    expect(inputHash("clips", { text: "hi", nonce: 0 })).not.toBe(a);
  });

  it("hashes strings and files with sha256", async () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(sha256("abc")).toBe(abc);
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    await writeFile(join(dir, "f.txt"), "abc");
    expect(await fileSha256(join(dir, "f.txt"))).toBe(abc);
  });
});

describe("store", () => {
  it("creates one scene state per mode", () => {
    const m = createManifest("run-1", request, models, new Date("2026-10-02T10:00:00Z"));
    expect(m.scenes.map((s) => [s.idx, s.mode])).toEqual([[0, 1], [1, 2]]);
    expect(m.createdAt).toBe("2026-10-02T10:00:00.000Z");
    expect(m.ledger).toEqual([]);
  });

  it("rejects a modes list that does not match the scene count", () => {
    expect(() => createManifest("r", { ...request, modes: [1] }, models)).toThrowError(/modes/);
  });

  it("round-trips through disk atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    const m = createManifest("run-1", request, models);
    m.scenes[0].stages.tts = { status: "done", inputHash: "h", costUsd: 0.01, finishedAt: "t" };
    await saveManifest(dir, m);
    expect(await loadManifest(dir)).toEqual(m);
    expect(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")).runId).toBe("run-1");
  });

  it("fills render defaults and validates the request", () => {
    const m = createManifest("run-1", request, models);
    expect(m.schemaVersion).toBe(2);
    expect(m.request.render).toEqual({ captionStyle: "preset", transition: "auto", bgmGain: 0.35 });
    expect(() => createManifest("r", { ...request, sceneCount: 13, modes: Array(13).fill(1) }, models)).toThrow();
  });

  it("starts an auto run as all Mode 1 until the modes stage runs, and needs a frozen budget and price table", () => {
    const auto = { ...request, sceneCount: 3, modes: undefined };
    const m = createManifest("run-1", { ...auto, modeBudgetUsd: 2, modePrices: Prices.parse({}) }, models);
    expect(m.scenes.map((s) => s.mode)).toEqual([1, 1, 1]);
    expect(m.request.modes).toBeUndefined();
    expect(() => createManifest("run-1", auto, models)).toThrow("auto modes need modeBudgetUsd and modePrices");
  });

  it("loads a manifest written before 2.2 (no style, explicit render options, no 2.2 script fields)", () => {
    const m = createManifest("run-1", { ...request, render: { captionStyle: "hormozi", transition: "fade" } }, models);
    m.script = {
      title: "t",
      styleBible: { artStyle: "a", characters: "c", palette: "p" },
      scenes: [{ narration: "n", imagePrompt: "i", motionPrompt: "m", shot: "cut", camera: "zoom_in" }],
    };
    const loaded = Manifest.parse(JSON.parse(JSON.stringify(m)));
    expect(loaded.request.render).toEqual({ captionStyle: "hormozi", transition: "fade", bgmGain: 0.35 });
    expect(loaded.script?.stylePreset).toBeUndefined();
  });

  it("rejects a manifest from an older flowchain with a clear message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, runId: "old-run" }));
    await expect(loadManifest(dir)).rejects.toThrow(
      "run old-run was created by an older flowchain (schema 1); start a new run",
    );
  });

  it("refuses to save an invalid manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    const m = createManifest("run-1", request, models);
    (m as { schemaVersion: number }).schemaVersion = 3;
    await expect(saveManifest(dir, m)).rejects.toThrow();
  });

  it("newRunId is timestamped and unique", () => {
    const now = new Date(2026, 9, 2, 14, 5, 9);
    const id = newRunId(now);
    expect(id).toMatch(/^20261002-140509-[0-9a-f]{6}$/);
    expect(newRunId(now)).not.toBe(id);
  });
});

describe("resolveModes", () => {
  it("leaves auto to the modes stage, and maps 1 and 2 to every scene", () => {
    expect(resolveModes("auto", undefined, 3)).toBeUndefined();
    expect(resolveModes("1", undefined, 2)).toEqual([1, 1]);
    expect(resolveModes("2", undefined, 2)).toEqual([2, 2]);
  });

  it("parses --modes and validates it", () => {
    expect(resolveModes("auto", "1,2, 1,1", 4)).toEqual([1, 2, 1, 1]);
    expect(() => resolveModes("auto", "1,3", 2)).toThrowError(/invalid mode "3"/);
    expect(() => resolveModes("auto", "1,2", 3)).toThrowError(/2 entries but --scenes is 3/);
    expect(() => resolveModes("fast", undefined, 3)).toThrowError(/invalid --mode/);
  });
});

describe("resolveShots", () => {
  it("is undefined when --shots is not given (the LLM decides)", () => {
    expect(resolveShots(undefined, 3)).toBeUndefined();
  });

  it("parses one continue/cut value per scene", () => {
    expect(resolveShots("cut, continue,continue", 3)).toEqual(["cut", "continue", "continue"]);
  });

  it("validates values, length and scene 1", () => {
    expect(() => resolveShots("cut,jump", 2)).toThrowError(/invalid shot "jump" in --shots \(use continue or cut\)/);
    expect(() => resolveShots("cut,continue", 3)).toThrowError(/--shots has 2 entries but --scenes is 3/);
    expect(() => resolveShots("continue,cut", 2)).toThrowError(/scene 1 must be "cut"/);
  });
});
