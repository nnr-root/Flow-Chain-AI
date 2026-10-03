# Phase 1 CLI Proof of Concept — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `flowchain`, a TypeScript CLI that turns a topic into a captioned short video via a resumable, cache-aware, audio-first pipeline (Gemini → ElevenLabs → silence removal → Flux keyframes → Kling continuity chain / Ken Burns → fit → ASS captions → final MP4 + `chain.png`).

**Architecture:** Eight stages (`script, tts, silence, keyframes, clips, fit, captions, assemble`) implement one `Stage` interface and read/write a zod-validated `manifest.json` in `runs/<runId>/`. A stage (or scene-stage) is skipped when its input hash (which includes upstream file hashes and a reroll nonce) matches its last successful record. `media/` holds pure ffmpeg logic with no manifest knowledge; `providers/` holds API adapters behind interfaces, with in-memory fakes for tests.

**Tech Stack:** Node ≥ 22.12 (machine has 25), TypeScript, `tsx`, `vitest`, `zod` v4, `commander`, `execa`, `@google/genai`, `@fal-ai/client`, system `ffmpeg`/`ffprobe` ≥ 6.

**Spec:** `docs/superpowers/specs/2026-10-02-phase1-cli-poc-design.md` — read it before starting any task.

## Global Constraints

- ESM project (`"type": "module"`); relative imports use the `.js` extension (`import { x } from "./x.js"`).
- Output: 9:16 → 1080×1920, 16:9 → 1920×1080, **30 fps**, H.264 `yuv420p` + AAC 192k, `+faststart`.
- Keyframes (Flux, multiples of 16): 9:16 → 1088×1920, 16:9 → 1920×1088.
- Narration ≤ **22 words** per scene; ≤ **12** scenes.
- Silence: `silencedetect=noise=-30dB:d=0.2`, **80 ms** padding, cut with `atrim` + `concat` (never `aselect`).
- Fit: max slow-down **1.25×**, then `tpad` freeze; every fit ends with a safety `tpad` and `-frames:v` exact.
- Frame counts come from **cumulative** rounding of audio durations (spec §4.4).
- Kling clip length: `audioDuration <= 5 ? 5 : 10`.
- Captions: font `Montserrat ExtraBold` from `assets/fonts/`, ≤ 3 words per page, active word `&H00E5FF&`.
- Loudness: `loudnorm=I=-14:TP=-1.5:LRA=11`. BGM base volume 0.35, `sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300`.
- Provider calls: 3 attempts, exponential backoff (base 2000 ms), timeouts LLM 60 s, TTS 60 s, image 120 s, video 600 s.
- Default models: `gemini-flash-latest`, `eleven_multilingual_v2`, `fal-ai/flux/dev`, `fal-ai/kling-video/v2.1/standard/image-to-video`.
- Default prices (USD): Flux 0.025/MP; Kling 0.25 per 5 s + 0.05/extra s; ElevenLabs 0.30/1k chars; Gemini 0.30/1M in, 2.50/1M out.
- Budget default `FLOWCHAIN_BUDGET_USD=3`; paid rerolls always confirm; `--yes` skips confirmation.
- Never commit `.env`, `runs/`, or generated media. Tests generate all media fixtures at runtime with `lavfi`.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviations from the spec's text (deliberate, recorded here and in the spec)

1. `SceneState` stores TTS output and trimmed audio separately (`tts: {raw, words}` and `audio: {path, duration, words, removedSec}`) so re-running `silence` never loses the original word timings.
2. The `Stage` interface receives the `StageContext` (it needs the run dir to hash files) and adds `paid`, `deps()` and `outputsFor()`. *(Superseded by the final-review fix wave:)* `run()` receives a `RunContext` (adds `inputHash` and `charge(usd)`) and returns nothing; paid stages call `ctx.charge()` right after each provider success, which appends the ledger entry and saves the manifest immediately.
3. fal image and video adapters live in one file, `src/providers/fal.ts` (they share one client).
4. LLM and TTS calls take no `AbortSignal`; `withRetry` enforces their timeouts by racing, which is acceptable only because repeating them cannot buy a long-running job twice. *(Corrected by the final-review fix wave:)* racing timeouts is **not** sufficient for fal image/video — abandoning a `subscribe` call and resubmitting leaves the first job running and billing. fal jobs therefore use the queue API (`queue.submit` once, request id saved in the manifest before waiting, then `queue.status` / `queue.result`); a timeout or error while waiting never resubmits, and resume polls the saved id (spec §6). `withRetry` no longer retries non-retryable errors (HTTP 400/401/403/404/422, errors marked non-retryable) and keeps the original error as `cause`.

## File Map

```
package.json  tsconfig.json  vitest.config.ts  .env.example  README.md
assets/fonts/Montserrat-ExtraBold.ttf  assets/fonts/OFL.txt
src/
  config.ts              env, sizes, FPS, prices
  cost.ts                cost formulas used by estimates AND ledger
  cli.ts                 commander entrypoint
  doctor.ts              environment / API checks
  status.ts              human-readable run status
  reroll.ts              nonce bump + validation
  pipeline.ts            planRun, runPipeline, checkpoints, ledger
  manifest/schema.ts     zod schemas + types
  manifest/hash.ts       stableStringify, sha256, fileSha256, inputHash
  manifest/store.ts      createManifest, load/save (atomic), newRunId, resolveModes
  media/ffmpeg.ts        ffmpeg/ffprobe wrappers
  media/silence.ts       parseSilencedetect, keepSegments, remapTimings, removeSilence
  media/timeline.ts      sceneFrameCounts, audioStarts, requestedSec
  media/fit.ts           planFit, fitFilter, applyFit
  media/frames.ts        extractFrame, extractLastFrame
  media/kenburns.ts      zoompanExpr, kenBurnsFilter, renderKenBurns
  media/contact-sheet.ts cellSize, contactSheet
  media/captions.ts      paginate, assTime, captionStyle, wordsToAss
  media/assemble.ts      concatVideos, concatAudio, finalizeFilter, finalize
  providers/types.ts     provider interfaces
  providers/retry.ts     withRetry, TIMEOUTS
  providers/download.ts  download (http(s) and file://)
  providers/gemini.ts    GeminiLlm, buildScriptPrompt, scriptJsonSchema
  providers/elevenlabs.ts ElevenLabsTts, wordsFromAlignment
  providers/fal.ts       createFal, FalImage, FalVideo, checkFal
  stages/types.ts        Stage, StageContext, Dep
  stages/paths.ts        run-relative file layout
  stages/require.ts      requireScript/Tts/Audio/Clip/Fitted guards
  stages/script.ts  stages/tts.ts  stages/silence.ts
  stages/visual.ts       needsKeyframe, chainImagePath, prompts, sceneFrames
  stages/keyframes.ts  stages/clips.ts  stages/fit.ts  stages/captions.ts  stages/assemble.ts
  stages/index.ts        STAGES registry (pipeline order)
test/
  helpers/media.ts       tempDir, makeAudio, makeVideo, makeImage, frameDiff
  helpers/context.ts     makeTestContext (fakes + small output sizes)
  fakes/providers.ts     FakeLlm, FakeTts, FakeImage, FakeVideo, fakeScript
  unit/*.test.ts         pure logic (no ffmpeg, no network)
  media/*.test.ts        real ffmpeg on generated fixtures
  stages/*.test.ts       stages with fakes
  pipeline/*.test.ts     end-to-end with fakes
```

---

### Task 1: Project scaffold, config, cost formulas

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `assets/fonts/Montserrat-ExtraBold.ttf`, `assets/fonts/OFL.txt`
- Create: `src/config.ts`, `src/cost.ts`
- Test: `test/unit/config.test.ts`, `test/unit/cost.test.ts`

**Interfaces:**
- Produces: `FPS`, `Aspect`, `Size`, `outputSize(aspect)`, `keyframeSize(aspect)`, `Env`, `loadEnv(source?)`, `Prices`, `loadPrices(path?)` from `src/config.ts`; `scriptCost`, `ttsCost`, `imageCost`, `videoCost`, `round4`, `FALLBACK_NARRATION_CHARS` from `src/cost.ts`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "flowchain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12" },
  "scripts": {
    "flowchain": "tsx src/cli.ts",
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "typecheck": "tsc --noEmit",
    "smoke": "tsx src/cli.ts run --topic \"A lighthouse keeper discovers the light is alive\" --scenes 3 --modes 1,1,1"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install @google/genai @fal-ai/client zod commander execa
npm install -D typescript tsx vitest @types/node
```
Expected: `package-lock.json` created, no errors. `npm ls zod` shows `4.x`.

- [ ] **Step 3: Create `tsconfig.json` and `vitest.config.ts`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
```

- [ ] **Step 4: Add the caption font and `.env.example`**

Run:
```bash
mkdir -p assets/fonts
curl -sfL -o assets/fonts/Montserrat-ExtraBold.ttf https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-ExtraBold.ttf
curl -sfL -o assets/fonts/OFL.txt https://raw.githubusercontent.com/JulietaUla/Montserrat/master/OFL.txt
file assets/fonts/Montserrat-ExtraBold.ttf
```
Expected: `TrueType Font data … The Montserrat Project Authors`.

`.env.example`:
```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-flash-latest
FAL_KEY=
FAL_IMAGE_MODEL=fal-ai/flux/dev
FAL_VIDEO_MODEL=fal-ai/kling-video/v2.1/standard/image-to-video
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL=eleven_multilingual_v2
FLOWCHAIN_BUDGET_USD=3
RUNS_DIR=./runs
```

- [ ] **Step 5: Write the failing tests**

`test/unit/config.test.ts`:
```ts
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
```

`test/unit/cost.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { imageCost, scriptCost, ttsCost, videoCost } from "../../src/cost.js";

const prices = Prices.parse({});

describe("cost formulas", () => {
  it("prices Kling clips by length", () => {
    expect(videoCost(prices, 5)).toBe(0.25);
    expect(videoCost(prices, 10)).toBe(0.5);
  });

  it("prices Flux by megapixel", () => {
    expect(imageCost(prices, { width: 1088, height: 1920 })).toBeCloseTo(0.0522, 4);
  });

  it("prices TTS by character", () => {
    expect(ttsCost(prices, 130)).toBeCloseTo(0.039, 4);
  });

  it("prices the script call from fixed token assumptions", () => {
    expect(scriptCost(prices)).toBeCloseTo(0.00545, 3);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts test/unit/cost.test.ts`
Expected: FAIL — cannot resolve `../../src/config.js`.

- [ ] **Step 7: Implement `src/config.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const FPS = 30;

export const Aspect = z.enum(["9:16", "16:9"]);
export type Aspect = z.infer<typeof Aspect>;

export type Size = { width: number; height: number };

export function outputSize(aspect: Aspect): Size {
  return aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

/** Flux needs multiples of 16; the fit stage crops down to the output size. */
export function keyframeSize(aspect: Aspect): Size {
  return aspect === "9:16" ? { width: 1088, height: 1920 } : { width: 1920, height: 1088 };
}

const Env = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default("gemini-flash-latest"),
  FAL_KEY: z.string().min(1),
  FAL_IMAGE_MODEL: z.string().min(1).default("fal-ai/flux/dev"),
  FAL_VIDEO_MODEL: z.string().min(1).default("fal-ai/kling-video/v2.1/standard/image-to-video"),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  ELEVENLABS_MODEL: z.string().min(1).default("eleven_multilingual_v2"),
  FLOWCHAIN_BUDGET_USD: z.coerce.number().positive().default(3),
  RUNS_DIR: z.string().min(1).default("./runs"),
});
export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment (copy .env.example to .env and fill it in):\n${problems}`);
  }
  return result.data;
}

export const Prices = z.object({
  fluxPerMegapixel: z.number().default(0.025),
  klingBase5s: z.number().default(0.25),
  klingPerExtraSec: z.number().default(0.05),
  ttsPer1kChars: z.number().default(0.3),
  llmPerMInputTokens: z.number().default(0.3),
  llmPerMOutputTokens: z.number().default(2.5),
});
export type Prices = z.infer<typeof Prices>;

export function loadPrices(path = "prices.json"): Prices {
  const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return Prices.parse(raw);
}
```

- [ ] **Step 8: Implement `src/cost.ts`**

```ts
import type { Prices, Size } from "./config.js";

/** Token assumptions for one script call (Gemini usage is not metered per call in Phase 1). */
export const SCRIPT_TOKENS = { input: 1500, output: 2000 };

/** Used by the first checkpoint, before the script exists. */
export const FALLBACK_NARRATION_CHARS = 130;

export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export function scriptCost(p: Prices): number {
  return round4((SCRIPT_TOKENS.input * p.llmPerMInputTokens + SCRIPT_TOKENS.output * p.llmPerMOutputTokens) / 1e6);
}

export function ttsCost(p: Prices, chars: number): number {
  return round4((chars / 1000) * p.ttsPer1kChars);
}

export function imageCost(p: Prices, size: Size): number {
  return round4((p.fluxPerMegapixel * size.width * size.height) / 1e6);
}

export function videoCost(p: Prices, seconds: 5 | 10): number {
  return round4(p.klingBase5s + Math.max(0, seconds - 5) * p.klingPerExtraSec);
}
```

- [ ] **Step 9: Run tests and typecheck**

Run: `npx vitest run test/unit/config.test.ts test/unit/cost.test.ts && npm run typecheck`
Expected: all tests PASS, `tsc` exits 0.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example assets src test
git commit -m "feat: scaffold flowchain CLI with config and cost formulas" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Manifest schema, hashing, store

**Files:**
- Create: `src/manifest/schema.ts`, `src/manifest/hash.ts`, `src/manifest/store.ts`
- Test: `test/unit/manifest.test.ts`

**Interfaces:**
- Consumes: `Aspect` from `src/config.ts`.
- Produces (schema.ts): zod schemas + types `StageName`, `Mode`, `Camera`, `SceneSpec`, `Script`, `WordTiming`, `StageRecord`, `FitPlan`, `SceneState`, `RunRequest`, `Models`, `LedgerEntry`, `Manifest`; constants `MAX_NARRATION_WORDS = 22`, `MAX_SCENES = 12`.
- Produces (hash.ts): `stableStringify(v): string`, `sha256(data: string | Buffer): string`, `fileSha256(path): Promise<string>`, `inputHash(stage: string, inputs: unknown): string`.
- Produces (store.ts): `MANIFEST_FILE`, `newRunId(now?)`, `createManifest(runId, request, models, now?)`, `saveManifest(dir, m)`, `loadManifest(dir)`, `resolveModes(mode, modes, sceneCount): Mode[]`.

- [ ] **Step 1: Write the failing test**

`test/unit/manifest.test.ts`:
```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileSha256, inputHash, sha256, stableStringify } from "../../src/manifest/hash.js";
import { createManifest, loadManifest, newRunId, resolveModes, saveManifest } from "../../src/manifest/store.js";

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

  it("refuses to save an invalid manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    const m = createManifest("run-1", request, models);
    (m as { schemaVersion: number }).schemaVersion = 2;
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
  it("defaults auto and 1 to Mode 1, 2 to Mode 2", () => {
    expect(resolveModes("auto", undefined, 3)).toEqual([1, 1, 1]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/manifest.test.ts`
Expected: FAIL — cannot resolve `../../src/manifest/hash.js`.

- [ ] **Step 3: Implement `src/manifest/schema.ts`**

```ts
import { z } from "zod";
import { Aspect } from "../config.js";

export const MAX_NARRATION_WORDS = 22;
export const MAX_SCENES = 12;

export const StageName = z.enum(["script", "tts", "silence", "keyframes", "clips", "fit", "captions", "assemble"]);
export type StageName = z.infer<typeof StageName>;

export const Mode = z.union([z.literal(1), z.literal(2)]);
export type Mode = z.infer<typeof Mode>;

export const Camera = z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"]);
export type Camera = z.infer<typeof Camera>;

export const SceneSpec = z.object({
  narration: z.string().describe(`Voiceover for this scene, at most ${MAX_NARRATION_WORDS} words`),
  imagePrompt: z.string().describe("What one still frame of this scene shows"),
  motionPrompt: z.string().describe("Camera movement and subject motion during this scene"),
  shot: z
    .enum(["continue", "cut"])
    .describe("continue = same place and moment as the previous scene; cut = new location, time or framing"),
  camera: Camera.describe("Camera move used if this scene is rendered from a still image"),
});
export type SceneSpec = z.infer<typeof SceneSpec>;

export const Script = z.object({
  title: z.string(),
  styleBible: z.object({
    artStyle: z.string(),
    characters: z.string(),
    palette: z.string(),
  }),
  scenes: z.array(SceneSpec).min(1).max(MAX_SCENES),
});
export type Script = z.infer<typeof Script>;

export const WordTiming = z.object({ text: z.string(), start: z.number(), end: z.number() });
export type WordTiming = z.infer<typeof WordTiming>;

export const StageRecord = z.object({
  status: z.enum(["done", "failed"]),
  inputHash: z.string(),
  costUsd: z.number(),
  finishedAt: z.string(),
  error: z.string().optional(),
});
export type StageRecord = z.infer<typeof StageRecord>;

export const FitPlan = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trim") }),
  z.object({ kind: z.literal("slow"), factor: z.number() }),
  z.object({ kind: z.literal("slow+freeze"), factor: z.literal(1.25), freezeSec: z.number() }),
]);
export type FitPlan = z.infer<typeof FitPlan>;

export const SceneState = z.object({
  idx: z.number().int(),
  mode: Mode,
  nonces: z.partialRecord(StageName, z.number().int()).default({}),
  stages: z.partialRecord(StageName, StageRecord).default({}),
  tts: z.object({ raw: z.string(), words: z.array(WordTiming) }).optional(),
  audio: z
    .object({ path: z.string(), duration: z.number(), words: z.array(WordTiming), removedSec: z.number() })
    .optional(),
  keyframe: z.object({ path: z.string(), seed: z.number(), sourceUrl: z.string() }).optional(),
  clip: z
    .object({
      path: z.string(),
      sourceUrl: z.string().optional(),
      duration: z.number(),
      requestedSec: z.union([z.literal(5), z.literal(10)]).optional(),
    })
    .optional(),
  lastFrame: z.object({ path: z.string(), sha256: z.string() }).optional(),
  fitted: z.object({ path: z.string(), frames: z.number().int(), plan: FitPlan }).optional(),
});
export type SceneState = z.infer<typeof SceneState>;

export const RunRequest = z.object({
  topic: z.string().min(1),
  aspect: Aspect,
  sceneCount: z.number().int().min(1).max(MAX_SCENES),
  modes: z.array(Mode),
  voiceId: z.string().min(1),
  bgm: z.string().optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;

export const Models = z.object({ llm: z.string(), tts: z.string(), image: z.string(), video: z.string() });
export type Models = z.infer<typeof Models>;

export const LedgerEntry = z.object({
  stage: StageName,
  scene: z.number().int().optional(),
  usd: z.number(),
  at: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const Manifest = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  createdAt: z.string(),
  request: RunRequest,
  models: Models,
  script: Script.optional(),
  runStages: z.partialRecord(StageName, StageRecord).default({}),
  scenes: z.array(SceneState),
  final: z.object({ path: z.string(), duration: z.number(), captions: z.string(), chain: z.string() }).optional(),
  ledger: z.array(LedgerEntry).default([]),
});
export type Manifest = z.infer<typeof Manifest>;
```

- [ ] **Step 4: Implement `src/manifest/hash.ts`**

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** JSON with sorted object keys and undefined values dropped, so equal data always hashes equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export function inputHash(stage: string, inputs: unknown): string {
  return sha256(stableStringify({ stage, inputs }));
}
```

- [ ] **Step 5: Implement `src/manifest/store.ts`**

```ts
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Manifest, type Mode, type Models, type RunRequest } from "./schema.js";

export const MANIFEST_FILE = "manifest.json";

export function newRunId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function createManifest(runId: string, request: RunRequest, models: Models, now: Date = new Date()): Manifest {
  if (request.modes.length !== request.sceneCount) {
    throw new Error(`modes has ${request.modes.length} entries but sceneCount is ${request.sceneCount}`);
  }
  return {
    schemaVersion: 1,
    runId,
    createdAt: now.toISOString(),
    request,
    models,
    runStages: {},
    scenes: request.modes.map((mode, idx) => ({ idx, mode, nonces: {}, stages: {} })),
    ledger: [],
  };
}

/** Validates, then writes to a temp file and renames, so a crash never leaves a half-written manifest. */
export async function saveManifest(dir: string, manifest: Manifest): Promise<void> {
  const valid = Manifest.parse(manifest);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${MANIFEST_FILE}.tmp`);
  await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`);
  await rename(tmp, join(dir, MANIFEST_FILE));
}

export async function loadManifest(dir: string): Promise<Manifest> {
  return Manifest.parse(JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8")));
}

export function resolveModes(mode: string, modes: string | undefined, sceneCount: number): Mode[] {
  if (modes !== undefined) {
    const parsed = modes.split(",").map((raw): Mode => {
      const s = raw.trim();
      if (s !== "1" && s !== "2") throw new Error(`invalid mode "${s}" in --modes (use 1 or 2)`);
      return s === "1" ? 1 : 2;
    });
    if (parsed.length !== sceneCount) {
      throw new Error(`--modes has ${parsed.length} entries but --scenes is ${sceneCount}`);
    }
    return parsed;
  }
  if (mode === "auto" || mode === "1") return Array.from({ length: sceneCount }, (): Mode => 1);
  if (mode === "2") return Array.from({ length: sceneCount }, (): Mode => 2);
  throw new Error(`invalid --mode "${mode}" (use auto, 1 or 2)`);
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/unit/manifest.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/manifest test/unit/manifest.test.ts
git commit -m "feat: add manifest schema, input hashing and atomic store" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ffmpeg wrapper and media test helpers

**Files:**
- Create: `src/media/ffmpeg.ts`, `test/helpers/media.ts`
- Test: `test/media/ffmpeg.test.ts`

**Interfaces:**
- Produces (ffmpeg.ts): `FfmpegError`, `ffmpeg(args: string[], opts?: { logLevel?: "error" | "info" }): Promise<string>` (returns stderr), `probeDuration(path): Promise<number>`, `countFrames(path): Promise<number>`, `probeVideo(path): Promise<{ width: number; height: number; fps: number }>`, `streamDuration(path, kind: "v" | "a"): Promise<number>`.
- Produces (helpers/media.ts): `tempDir(prefix?)`, `AudioPart`, `makeAudio(path, parts)`, `makeVideo(path, opts)`, `makeImage(path, opts)`, `frameDiff(a, b): Promise<number>`.

- [ ] **Step 1: Write the helpers (test infrastructure, no test of their own)**

`test/helpers/media.ts`:
```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg } from "../../src/media/ffmpeg.js";

export async function tempDir(prefix = "flowchain-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export type AudioPart = { tone: number; freq?: number } | { silence: number };

/** 48 kHz mono audio made of tones and silences; codec chosen by extension (.wav / .mp3). */
export async function makeAudio(path: string, parts: AudioPart[]): Promise<void> {
  const inputs = parts.flatMap((p) =>
    "tone" in p
      ? ["-f", "lavfi", "-i", `sine=f=${p.freq ?? 440}:d=${p.tone}:sample_rate=48000`]
      : ["-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono:d=${p.silence}`],
  );
  const labels = parts.map((_, i) => `[${i}:a]`).join("");
  const filter = `${labels}concat=n=${parts.length}:v=0:a=1,aformat=channel_layouts=mono[a]`;
  await ffmpeg([...inputs, "-filter_complex", filter, "-map", "[a]", path]);
}

export type VideoOptions = {
  seconds?: number;
  frames?: number;
  fps?: number;
  width?: number;
  height?: number;
  /** Rotates hues so different calls produce visibly different (and differently hashed) videos. */
  hue?: number;
};

export async function makeVideo(path: string, o: VideoOptions = {}): Promise<void> {
  const fps = o.fps ?? 30;
  const width = o.width ?? 320;
  const height = o.height ?? 240;
  const frames = o.frames ?? Math.round((o.seconds ?? 1) * fps);
  const vf = o.hue === undefined ? "format=yuv420p" : `hue=h=${o.hue},format=yuv420p`;
  await ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=${fps}`,
    "-vf", vf, "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "ultrafast", path,
  ]);
}

export async function makeImage(path: string, o: { width: number; height: number; color?: string }): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-i", `color=c=${o.color ?? "0x3366aa"}:s=${o.width}x${o.height}`, "-frames:v", "1", path]);
}

/** Mean luma of |a − b|; 0 means pixel-identical. Both images must have the same size. */
export async function frameDiff(a: string, b: string): Promise<number> {
  const log = await ffmpeg(
    ["-i", a, "-i", b, "-filter_complex",
      "[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
      "-f", "null", "-"],
    { logLevel: "info" },
  );
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(log);
  if (!m) throw new Error("frameDiff: no YAVG in ffmpeg output");
  return Number(m[1]);
}
```

- [ ] **Step 2: Write the failing test**

`test/media/ffmpeg.test.ts`:
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countFrames, ffmpeg, FfmpegError, probeDuration, probeVideo, streamDuration } from "../../src/media/ffmpeg.js";
import { makeAudio, makeVideo, tempDir } from "../helpers/media.js";

describe("ffmpeg wrapper", () => {
  it("probes generated video", async () => {
    const dir = await tempDir();
    const v = join(dir, "v.mp4");
    await makeVideo(v, { seconds: 2, fps: 30 });
    expect(await countFrames(v)).toBe(60);
    expect(await probeVideo(v)).toEqual({ width: 320, height: 240, fps: 30 });
    expect(await streamDuration(v, "v")).toBeCloseTo(2, 2);
  });

  it("probes generated audio", async () => {
    const dir = await tempDir();
    const a = join(dir, "a.wav");
    await makeAudio(a, [{ tone: 1 }, { silence: 0.5 }]);
    expect(await probeDuration(a)).toBeCloseTo(1.5, 2);
  });

  it("throws FfmpegError with stderr on failure", async () => {
    await expect(ffmpeg(["-i", "/nonexistent.mp4", "/tmp/x.mp4"])).rejects.toBeInstanceOf(FfmpegError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/media/ffmpeg.test.ts`
Expected: FAIL — cannot resolve `../../src/media/ffmpeg.js`.

- [ ] **Step 4: Implement `src/media/ffmpeg.ts`**

```ts
import { execa } from "execa";

export class FfmpegError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`ffmpeg failed: ffmpeg ${args.join(" ")}\n${stderr.split("\n").slice(-15).join("\n")}`);
  }
}

/** Runs ffmpeg and returns its stderr (where filters such as silencedetect report). */
export async function ffmpeg(args: string[], opts: { logLevel?: "error" | "info" } = {}): Promise<string> {
  const full = ["-hide_banner", "-nostdin", "-nostats", "-y", "-v", opts.logLevel ?? "error", ...args];
  const r = await execa("ffmpeg", full, { reject: false, maxBuffer: 64 * 1024 * 1024 });
  if (r.exitCode !== 0) throw new FfmpegError(full, String(r.stderr));
  return String(r.stderr);
}

async function ffprobe(args: string[]): Promise<string> {
  const r = await execa("ffprobe", ["-v", "error", ...args], { reject: false });
  if (r.exitCode !== 0) throw new Error(`ffprobe failed: ${String(r.stderr)}`);
  return String(r.stdout).trim();
}

export async function probeDuration(path: string): Promise<number> {
  const d = Number.parseFloat(await ffprobe(["-show_entries", "format=duration", "-of", "csv=p=0", path]));
  if (!Number.isFinite(d)) throw new Error(`could not read duration of ${path}`);
  return d;
}

export async function countFrames(path: string): Promise<number> {
  const out = await ffprobe([
    "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path,
  ]);
  return Number.parseInt(out, 10);
}

export async function probeVideo(path: string): Promise<{ width: number; height: number; fps: number }> {
  const out = await ffprobe([
    "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", path,
  ]);
  const [w, h, rate] = out.split(",");
  const [num, den] = rate.split("/").map(Number);
  return { width: Number(w), height: Number(h), fps: num / (den || 1) };
}

export async function streamDuration(path: string, kind: "v" | "a"): Promise<number> {
  const out = await ffprobe(["-select_streams", `${kind}:0`, "-show_entries", "stream=duration", "-of", "csv=p=0", path]);
  return Number.parseFloat(out);
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/media/ffmpeg.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/media/ffmpeg.ts test/helpers/media.ts test/media/ffmpeg.test.ts
git commit -m "feat: add ffmpeg/ffprobe wrappers and lavfi media fixtures" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Silence removal with word-timing remap

**Files:**
- Create: `src/media/silence.ts`
- Test: `test/unit/silence.test.ts`, `test/media/silence.test.ts`

**Interfaces:**
- Consumes: `ffmpeg`, `probeDuration` (Task 3).
- Produces: `Interval = { start: number; end: number }`, `parseSilencedetect(stderr, total): Interval[]`, `keepSegments(silences, total, padding?): Interval[]`, `remapTime(t, keep): number`, `remapTimings<W extends {start,end}>(words, keep): W[]`, `SilenceOptions`, `removeSilence(input, output, opts?): Promise<{ keep: Interval[]; duration: number; removedSec: number }>`.

- [ ] **Step 1: Write the failing unit test**

`test/unit/silence.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { keepSegments, parseSilencedetect, remapTimings } from "../../src/media/silence.js";

const STDERR = `[Parsed_silencedetect_0 @ 0x7b91004e40] silence_start: 0.999917
[Parsed_silencedetect_0 @ 0x7b91004e40] silence_end: 1.600062 | silence_duration: 0.600146
[Parsed_silencedetect_0 @ 0x7b91004e40] silence_start: 2.599958
[Parsed_silencedetect_0 @ 0x7b91004e40] silence_end: 2.9 | silence_duration: 0.300042`;

describe("parseSilencedetect", () => {
  it("pairs starts and ends", () => {
    expect(parseSilencedetect(STDERR, 2.9)).toEqual([
      { start: 0.999917, end: 1.600062 },
      { start: 2.599958, end: 2.9 },
    ]);
  });

  it("closes an unterminated silence at the end of the file", () => {
    expect(parseSilencedetect("x silence_start: 2.5\n", 3)).toEqual([{ start: 2.5, end: 3 }]);
  });

  it("clamps negative starts to zero", () => {
    expect(parseSilencedetect("silence_start: -0.0213\nsilence_end: 0.4 | d", 3)).toEqual([{ start: 0, end: 0.4 }]);
  });
});

describe("keepSegments", () => {
  it("keeps 80 ms around speech for interior and trailing silences", () => {
    const keep = keepSegments(parseSilencedetect(STDERR, 2.9), 2.9);
    expect(keep).toHaveLength(2);
    expect(keep[0].start).toBe(0);
    expect(keep[0].end).toBeCloseTo(1.079917, 6);
    expect(keep[1].start).toBeCloseTo(1.520062, 6);
    expect(keep[1].end).toBeCloseTo(2.679958, 6);
  });

  it("trims leading silence down to the padding", () => {
    const keep = keepSegments([{ start: 0, end: 0.5 }], 1.5);
    expect(keep).toHaveLength(1);
    expect(keep[0].start).toBeCloseTo(0.42, 6);
    expect(keep[0].end).toBe(1.5);
  });

  it("drops silences shorter than twice the padding", () => {
    expect(keepSegments([{ start: 1, end: 1.15 }], 2)).toEqual([{ start: 0, end: 2 }]);
  });

  it("keeps everything when there is no silence", () => {
    expect(keepSegments([], 2)).toEqual([{ start: 0, end: 2 }]);
  });

  it("keeps nothing when the whole file is silent", () => {
    expect(keepSegments([{ start: 0, end: 2 }], 2)).toEqual([]);
  });
});

describe("remapTimings", () => {
  const keep = [
    { start: 0, end: 1 },
    { start: 1.5, end: 2.5 },
  ];

  it("shifts words after a cut and snaps times inside a cut to its edge", () => {
    const out = remapTimings(
      [
        { text: "a", start: 0.2, end: 0.8 },
        { text: "b", start: 1.2, end: 1.7 },
        { text: "c", start: 1.6, end: 2.0 },
        { text: "d", start: 2.4, end: 2.6 },
      ],
      keep,
    );
    expect(out.map((w) => [w.text, +w.start.toFixed(3), +w.end.toFixed(3)])).toEqual([
      ["a", 0.2, 0.8],
      ["b", 1.0, 1.2],
      ["c", 1.1, 1.5],
      ["d", 1.9, 2.0],
    ]);
  });

  it("gives a word that falls entirely inside a cut a 40 ms span", () => {
    const [w] = remapTimings([{ text: "e", start: 1.1, end: 1.3 }], keep);
    expect(w.start).toBeCloseTo(1.0, 6);
    expect(w.end).toBeCloseTo(1.04, 6);
  });
});
```

- [ ] **Step 2: Write the failing media test**

`test/media/silence.test.ts`:
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeDuration } from "../../src/media/ffmpeg.js";
import { removeSilence } from "../../src/media/silence.js";
import { makeAudio, tempDir } from "../helpers/media.js";

describe("removeSilence", () => {
  it("cuts interior and trailing silence to within 20 ms of the expected length", async () => {
    const dir = await tempDir();
    const input = join(dir, "in.wav");
    await makeAudio(input, [{ tone: 1 }, { silence: 0.6 }, { tone: 1, freq: 660 }, { silence: 0.3 }]);
    const out = join(dir, "out.wav");
    const r = await removeSilence(input, out);
    expect(r.keep).toHaveLength(2);
    expect(r.duration).toBeGreaterThan(2.22);
    expect(r.duration).toBeLessThan(2.26);
    expect(await probeDuration(out)).toBeCloseTo(r.duration, 3);
    expect(r.removedSec).toBeCloseTo(2.9 - r.duration, 3);
  });

  it("accepts MP3 input and trims leading silence", async () => {
    const dir = await tempDir();
    const input = join(dir, "in.mp3");
    await makeAudio(input, [{ silence: 0.5 }, { tone: 1 }]);
    const r = await removeSilence(input, join(dir, "out.wav"));
    expect(r.duration).toBeGreaterThan(1.03);
    expect(r.duration).toBeLessThan(1.13);
  });

  it("rejects audio that is entirely silent", async () => {
    const dir = await tempDir();
    const input = join(dir, "in.wav");
    await makeAudio(input, [{ silence: 1 }]);
    await expect(removeSilence(input, join(dir, "out.wav"))).rejects.toThrow(/entirely silent/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/silence.test.ts test/media/silence.test.ts`
Expected: FAIL — cannot resolve `../../src/media/silence.js`.

- [ ] **Step 4: Implement `src/media/silence.ts`**

```ts
import { rm } from "node:fs/promises";
import { ffmpeg, probeDuration } from "./ffmpeg.js";

export type Interval = { start: number; end: number };

const EPS = 1e-3;
const MIN_WORD_SEC = 0.04;

export function parseSilencedetect(stderr: string, total: number): Interval[] {
  const out: Interval[] = [];
  let open: number | undefined;
  for (const line of stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) {
      open = Math.max(0, Number(s[1]));
      continue;
    }
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (e && open !== undefined) {
      out.push({ start: open, end: Number(e[1]) });
      open = undefined;
    }
  }
  if (open !== undefined) out.push({ start: open, end: total });
  return out;
}

/**
 * Complement of the silences, keeping `padding` seconds of each silence next to speech.
 * Leading silence keeps only the padding before speech; trailing silence only the padding after it.
 */
export function keepSegments(silences: Interval[], total: number, padding = 0.08): Interval[] {
  const removed: Interval[] = [];
  for (const s of silences) {
    const start = s.start <= EPS ? 0 : s.start + padding;
    const end = s.end >= total - EPS ? total : s.end - padding;
    if (end - start > EPS) removed.push({ start, end });
  }
  removed.sort((a, b) => a.start - b.start);
  const keep: Interval[] = [];
  let cursor = 0;
  for (const r of removed) {
    if (r.start - cursor > EPS) keep.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (total - cursor > EPS) keep.push({ start: cursor, end: total });
  return keep;
}

/** Maps a time on the original timeline onto the trimmed one; times inside a cut snap to the cut point. */
export function remapTime(t: number, keep: Interval[]): number {
  let offset = 0;
  for (const seg of keep) {
    if (t < seg.start) return offset;
    if (t <= seg.end) return offset + (t - seg.start);
    offset += seg.end - seg.start;
  }
  return offset;
}

export function remapTimings<W extends { start: number; end: number }>(words: W[], keep: Interval[]): W[] {
  return words.map((w) => {
    const start = remapTime(w.start, keep);
    const end = Math.max(remapTime(w.end, keep), start + MIN_WORD_SEC);
    return { ...w, start, end };
  });
}

export type SilenceOptions = { noiseDb?: number; minSilence?: number; padding?: number };
export type SilenceResult = { keep: Interval[]; duration: number; removedSec: number };

/** Writes 48 kHz mono PCM WAV with internal/edge silences removed (sample-accurate atrim + concat). */
export async function removeSilence(input: string, output: string, opts: SilenceOptions = {}): Promise<SilenceResult> {
  const { noiseDb = -30, minSilence = 0.2, padding = 0.08 } = opts;
  const full = `${output}.full.wav`;
  await ffmpeg(["-i", input, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", full]);
  try {
    const total = await probeDuration(full);
    const log = await ffmpeg(["-i", full, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, "-f", "null", "-"], {
      logLevel: "info",
    });
    const keep = keepSegments(parseSilencedetect(log, total), total, padding);
    if (keep.length === 0) throw new Error(`${input} is entirely silent`);
    const chains = keep.map(
      (k, i) => `[0:a]atrim=start=${k.start.toFixed(6)}:end=${k.end.toFixed(6)},asetpts=PTS-STARTPTS[s${i}]`,
    );
    const joined = keep.map((_, i) => `[s${i}]`).join("");
    const filter = `${chains.join(";")};${joined}concat=n=${keep.length}:v=0:a=1[out]`;
    await ffmpeg(["-i", full, "-filter_complex", filter, "-map", "[out]", "-c:a", "pcm_s16le", output]);
    const duration = await probeDuration(output);
    return { keep, duration, removedSec: total - duration };
  } finally {
    await rm(full, { force: true });
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/unit/silence.test.ts test/media/silence.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/media/silence.ts test/unit/silence.test.ts test/media/silence.test.ts
git commit -m "feat: add sample-accurate silence removal with word-timing remap" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Frame-exact timeline and clip fitting

**Files:**
- Create: `src/media/timeline.ts`, `src/media/fit.ts`
- Test: `test/unit/timeline-fit.test.ts`, `test/media/fit.test.ts`

**Interfaces:**
- Consumes: `ffmpeg` (Task 3); `Size` (Task 1).
- Produces (timeline.ts): `sceneFrameCounts(durations: number[], fps: number): number[]`, `audioStarts(durations: number[]): number[]`, `requestedSec(audioDuration: number): 5 | 10`.
- Produces (fit.ts): `MAX_SLOW = 1.25`, `FitPlan` (TS type, structurally identical to the manifest's), `planFit(clipDur, targetDur): FitPlan`, `fitFilter(plan, size, fps): string`, `applyFit(input, output, plan, frames, size, fps): Promise<void>`.

- [ ] **Step 1: Write the failing unit test**

`test/unit/timeline-fit.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fitFilter, planFit } from "../../src/media/fit.js";
import { audioStarts, requestedSec, sceneFrameCounts } from "../../src/media/timeline.js";

describe("sceneFrameCounts", () => {
  it("uses cumulative rounding so the total never drifts", () => {
    expect(sceneFrameCounts([1.01, 1.01, 1.01], 30)).toEqual([30, 31, 30]);
  });

  it("always sums to round(total * fps)", () => {
    const durations = [2.137, 4.481, 0.999, 7.333, 3.0166, 5.5];
    const total = durations.reduce((a, b) => a + b, 0);
    const counts = sceneFrameCounts(durations, 30);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(Math.round(total * 30));
  });
});

describe("audioStarts", () => {
  it("returns cumulative start times", () => {
    expect(audioStarts([1.5, 2, 0.5])).toEqual([0, 1.5, 3.5]);
  });
});

describe("requestedSec", () => {
  it("picks the shortest Kling length that covers the audio", () => {
    expect(requestedSec(3)).toBe(5);
    expect(requestedSec(5)).toBe(5);
    expect(requestedSec(5.01)).toBe(10);
  });
});

describe("planFit", () => {
  it("trims when the clip is long enough", () => {
    expect(planFit(5, 4.2)).toEqual({ kind: "trim" });
    expect(planFit(5, 5)).toEqual({ kind: "trim" });
  });

  it("slows down by up to 1.25x", () => {
    expect(planFit(5, 6)).toEqual({ kind: "slow", factor: 1.2 });
    expect(planFit(5, 6.25)).toEqual({ kind: "slow", factor: 1.25 });
  });

  it("freezes the tail beyond 1.25x", () => {
    expect(planFit(5, 7)).toEqual({ kind: "slow+freeze", factor: 1.25, freezeSec: 0.75 });
  });
});

describe("fitFilter", () => {
  const size = { width: 1080, height: 1920 };

  it("normalizes size and fps and always pads the tail", () => {
    expect(fitFilter({ kind: "trim" }, size, 30)).toBe(
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.500",
    );
  });

  it("slows with setpts and extends the freeze for freeze plans", () => {
    const f = fitFilter({ kind: "slow+freeze", factor: 1.25, freezeSec: 0.75 }, size, 30);
    expect(f.startsWith("setpts=1.25*PTS,")).toBe(true);
    expect(f.endsWith("tpad=stop_mode=clone:stop_duration=1.250")).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing media test**

`test/media/fit.test.ts`:
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countFrames, probeVideo } from "../../src/media/ffmpeg.js";
import { applyFit, planFit } from "../../src/media/fit.js";
import { makeVideo, tempDir } from "../helpers/media.js";

const size = { width: 180, height: 320 };

describe("applyFit", () => {
  for (const [target, kind] of [[2, "trim"], [3.5, "slow"], [6, "slow+freeze"]] as const) {
    it(`produces exactly target frames for a ${kind} plan`, async () => {
      const dir = await tempDir();
      const clip = join(dir, "clip.mp4");
      await makeVideo(clip, { seconds: 3, fps: 24, width: 320, height: 240 });
      const plan = planFit(3, target);
      expect(plan.kind).toBe(kind);
      const out = join(dir, "fit.mp4");
      const frames = Math.round(target * 30);
      await applyFit(clip, out, plan, frames, size, 30);
      expect(await countFrames(out)).toBe(frames);
      expect(await probeVideo(out)).toEqual({ ...size, fps: 30 });
    });
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/timeline-fit.test.ts test/media/fit.test.ts`
Expected: FAIL — cannot resolve `../../src/media/fit.js`.

- [ ] **Step 4: Implement `src/media/timeline.ts`**

```ts
/** Frames per scene from cumulative audio boundaries: total = round(Σd · fps), max offset ½ frame. */
export function sceneFrameCounts(durations: number[], fps: number): number[] {
  let elapsed = 0;
  let prevFrame = 0;
  return durations.map((d) => {
    elapsed += d;
    const frame = Math.round(elapsed * fps);
    const count = frame - prevFrame;
    prevFrame = frame;
    return count;
  });
}

export function audioStarts(durations: number[]): number[] {
  let t = 0;
  return durations.map((d) => {
    const start = t;
    t += d;
    return start;
  });
}

export function requestedSec(audioDuration: number): 5 | 10 {
  return audioDuration <= 5 ? 5 : 10;
}
```

- [ ] **Step 5: Implement `src/media/fit.ts`**

```ts
import type { Size } from "../config.js";
import { ffmpeg } from "./ffmpeg.js";

export const MAX_SLOW = 1.25 as const;

export type FitPlan =
  | { kind: "trim" }
  | { kind: "slow"; factor: number }
  | { kind: "slow+freeze"; factor: typeof MAX_SLOW; freezeSec: number };

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function planFit(clipDur: number, targetDur: number): FitPlan {
  if (clipDur >= targetDur) return { kind: "trim" };
  const ratio = targetDur / clipDur;
  if (ratio <= MAX_SLOW) return { kind: "slow", factor: r4(ratio) };
  return { kind: "slow+freeze", factor: MAX_SLOW, freezeSec: r4(targetDur - clipDur * MAX_SLOW) };
}

/** The trailing tpad guarantees enough frames after fps conversion; -frames:v cuts to the exact count. */
export function fitFilter(plan: FitPlan, size: Size, fps: number): string {
  const parts: string[] = [];
  if (plan.kind !== "trim") parts.push(`setpts=${plan.factor}*PTS`);
  parts.push(
    `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase`,
    `crop=${size.width}:${size.height}`,
    `fps=${fps}`,
    "format=yuv420p",
  );
  const pad = plan.kind === "slow+freeze" ? plan.freezeSec + 0.5 : 0.5;
  parts.push(`tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`);
  return parts.join(",");
}

export async function applyFit(
  input: string,
  output: string,
  plan: FitPlan,
  frames: number,
  size: Size,
  fps: number,
): Promise<void> {
  await ffmpeg([
    "-i", input, "-vf", fitFilter(plan, size, fps), "-frames:v", String(frames), "-an",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), output,
  ]);
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/unit/timeline-fit.test.ts test/media/fit.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/media/timeline.ts src/media/fit.ts test/unit/timeline-fit.test.ts test/media/fit.test.ts
git commit -m "feat: add frame-exact timeline and trim/slow/freeze clip fitting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Frame extraction, Ken Burns, contact sheet

**Files:**
- Create: `src/media/frames.ts`, `src/media/kenburns.ts`, `src/media/contact-sheet.ts`
- Test: `test/unit/kenburns.test.ts`, `test/media/frames.test.ts`

**Interfaces:**
- Consumes: `ffmpeg`, `countFrames` (Task 3); `Size` (Task 1); `Camera` type (Task 2).
- Produces (frames.ts): `extractFrame(video, index, out)`, `extractLastFrame(video, out)`.
- Produces (kenburns.ts): `zoompanExpr(camera, frames): { z: string; x: string; y: string }`, `kenBurnsFilter(camera, frames, size, fps): string`, `renderKenBurns(image, out, camera, frames, size, fps): Promise<void>`.
- Produces (contact-sheet.ts): `cellSize(output: Size, rowHeight?): Size`, `contactSheet(rows: Array<{ first: string; last: string }>, out, cell: Size): Promise<void>`.

- [ ] **Step 1: Write the failing unit test**

`test/unit/kenburns.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { cellSize } from "../../src/media/contact-sheet.js";
import { kenBurnsFilter, zoompanExpr } from "../../src/media/kenburns.js";

const CENTER_X = "iw/2-(iw/zoom/2)";
const CENTER_Y = "ih/2-(ih/zoom/2)";

describe("zoompanExpr", () => {
  it("zooms around the center", () => {
    expect(zoompanExpr("zoom_in", 73)).toEqual({ z: "1+0.15*on/72", x: CENTER_X, y: CENTER_Y });
    expect(zoompanExpr("zoom_out", 73)).toEqual({ z: "1.15-0.15*on/72", x: CENTER_X, y: CENTER_Y });
  });

  it("pans at a fixed 1.15 zoom", () => {
    expect(zoompanExpr("pan_left", 73)).toEqual({ z: "1.15", x: "(iw-iw/zoom)*(1-on/72)", y: CENTER_Y });
    expect(zoompanExpr("pan_right", 73)).toEqual({ z: "1.15", x: "(iw-iw/zoom)*(on/72)", y: CENTER_Y });
    expect(zoompanExpr("pan_up", 73)).toEqual({ z: "1.15", x: CENTER_X, y: "(ih-ih/zoom)*(1-on/72)" });
    expect(zoompanExpr("pan_down", 73)).toEqual({ z: "1.15", x: CENTER_X, y: "(ih-ih/zoom)*(on/72)" });
  });

  it("never divides by zero for a one-frame scene", () => {
    expect(zoompanExpr("zoom_in", 1).z).toBe("1+0.15*on/1");
  });
});

describe("kenBurnsFilter", () => {
  it("oversamples 4x at the output aspect before zoompan", () => {
    const f = kenBurnsFilter("zoom_in", 15, { width: 180, height: 320 }, 30);
    expect(f).toContain("scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,zoompan=");
    expect(f).toContain(":d=15:s=180x320:fps=30,format=yuv420p[v]");
  });
});

describe("cellSize", () => {
  it("keeps the output aspect at a 360 px row height with an even width", () => {
    expect(cellSize({ width: 1080, height: 1920 })).toEqual({ width: 202, height: 360 });
    expect(cellSize({ width: 1920, height: 1080 })).toEqual({ width: 640, height: 360 });
  });
});
```

- [ ] **Step 2: Write the failing media test**

`test/media/frames.test.ts`:
```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cellSize, contactSheet } from "../../src/media/contact-sheet.js";
import { countFrames, probeVideo } from "../../src/media/ffmpeg.js";
import { extractFrame, extractLastFrame } from "../../src/media/frames.js";
import { Camera } from "../../src/manifest/schema.js";
import { renderKenBurns } from "../../src/media/kenburns.js";
import { frameDiff, makeImage, makeVideo, tempDir } from "../helpers/media.js";

describe("extractLastFrame", () => {
  it("returns the true final frame", async () => {
    const dir = await tempDir();
    const v = join(dir, "v.mp4");
    await makeVideo(v, { seconds: 2, fps: 30 });
    await extractLastFrame(v, join(dir, "last.png"));
    await extractFrame(v, 59, join(dir, "ref.png"));
    await extractFrame(v, 0, join(dir, "first.png"));
    expect(await frameDiff(join(dir, "last.png"), join(dir, "ref.png"))).toBe(0);
    expect(await frameDiff(join(dir, "last.png"), join(dir, "first.png"))).toBeGreaterThan(0);
  });

  it("works on clips shorter than one second", async () => {
    const dir = await tempDir();
    const v = join(dir, "short.mp4");
    await makeVideo(v, { frames: 12, fps: 30 });
    await extractLastFrame(v, join(dir, "last.png"));
    await extractFrame(v, 11, join(dir, "ref.png"));
    expect(await frameDiff(join(dir, "last.png"), join(dir, "ref.png"))).toBe(0);
  });
});

describe("renderKenBurns", () => {
  for (const camera of Camera.options) {
    it(`renders ${camera} at the exact frame count`, async () => {
      const dir = await tempDir();
      const img = join(dir, "kf.png");
      await makeImage(img, { width: 192, height: 336 });
      const out = join(dir, "kb.mp4");
      await renderKenBurns(img, out, camera, 15, { width: 180, height: 320 }, 30);
      expect(await countFrames(out)).toBe(15);
      expect(await probeVideo(out)).toEqual({ width: 180, height: 320, fps: 30 });
    });
  }
});

describe("contactSheet", () => {
  it("lays out first/last pairs as rows", async () => {
    const dir = await tempDir();
    const rows = [];
    for (const n of [1, 2]) {
      const first = join(dir, `f${n}.png`);
      const last = join(dir, `l${n}.png`);
      await makeImage(first, { width: 180, height: 320, color: "red" });
      await makeImage(last, { width: 180, height: 320, color: "blue" });
      rows.push({ first, last });
    }
    const cell = cellSize({ width: 180, height: 320 });
    const out = join(dir, "chain.png");
    await contactSheet(rows, out, cell);
    const { width, height } = await probeVideo(out);
    expect({ width, height }).toEqual({ width: cell.width * 2, height: cell.height * 2 });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/kenburns.test.ts test/media/frames.test.ts`
Expected: FAIL — cannot resolve `../../src/media/contact-sheet.js`.

- [ ] **Step 4: Implement `src/media/frames.ts`**

```ts
import { rm, stat } from "node:fs/promises";
import { countFrames, ffmpeg } from "./ffmpeg.js";

async function nonEmpty(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

export async function extractFrame(video: string, index: number, out: string): Promise<void> {
  await ffmpeg(["-i", video, "-vf", `select=eq(n\\,${index})`, "-frames:v", "1", out]);
}

/**
 * Lossless PNG of the final decodable frame (the chain image for the next Mode 1 scene).
 * Fast path decodes only the last second; the fallback counts frames and selects the last one.
 */
export async function extractLastFrame(video: string, out: string): Promise<void> {
  await rm(out, { force: true });
  try {
    await ffmpeg(["-sseof", "-1", "-i", video, "-update", "1", out]);
  } catch {
    // fall through to the exact path below
  }
  if (await nonEmpty(out)) return;
  const frames = await countFrames(video);
  await extractFrame(video, frames - 1, out);
  if (!(await nonEmpty(out))) throw new Error(`could not extract the last frame of ${video}`);
}
```

- [ ] **Step 5: Implement `src/media/kenburns.ts`**

```ts
import type { Size } from "../config.js";
import type { Camera } from "../manifest/schema.js";
import { ffmpeg } from "./ffmpeg.js";

// Literal strings: 1.15 - 1 in floating point is 0.1499999…, which would leak into the filter.
const MAX_ZOOM = "1.15";
const ZOOM_DELTA = "0.15";
const CENTER_X = "iw/2-(iw/zoom/2)";
const CENTER_Y = "ih/2-(ih/zoom/2)";

export function zoompanExpr(camera: Camera, frames: number): { z: string; x: string; y: string } {
  const p = `on/${Math.max(frames - 1, 1)}`;
  switch (camera) {
    case "zoom_in":
      return { z: `1+${ZOOM_DELTA}*${p}`, x: CENTER_X, y: CENTER_Y };
    case "zoom_out":
      return { z: `${MAX_ZOOM}-${ZOOM_DELTA}*${p}`, x: CENTER_X, y: CENTER_Y };
    case "pan_left":
      return { z: MAX_ZOOM, x: `(iw-iw/zoom)*(1-${p})`, y: CENTER_Y };
    case "pan_right":
      return { z: MAX_ZOOM, x: `(iw-iw/zoom)*(${p})`, y: CENTER_Y };
    case "pan_up":
      return { z: MAX_ZOOM, x: CENTER_X, y: `(ih-ih/zoom)*(1-${p})` };
    case "pan_down":
      return { z: MAX_ZOOM, x: CENTER_X, y: `(ih-ih/zoom)*(${p})` };
  }
}

/** Crops to the output aspect at 4x resolution first; zoompan on a small source jitters visibly. */
export function kenBurnsFilter(camera: Camera, frames: number, size: Size, fps: number): string {
  const { z, x, y } = zoompanExpr(camera, frames);
  const W = size.width * 4;
  const H = size.height * 4;
  return (
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${size.width}x${size.height}:fps=${fps},format=yuv420p[v]`
  );
}

export async function renderKenBurns(
  image: string,
  out: string,
  camera: Camera,
  frames: number,
  size: Size,
  fps: number,
): Promise<void> {
  await ffmpeg([
    "-i", image, "-filter_complex", kenBurnsFilter(camera, frames, size, fps), "-map", "[v]",
    "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", out,
  ]);
}
```

- [ ] **Step 6: Implement `src/media/contact-sheet.ts`**

```ts
import type { Size } from "../config.js";
import { ffmpeg } from "./ffmpeg.js";

export function cellSize(output: Size, rowHeight = 360): Size {
  return { width: Math.round((rowHeight * output.width) / output.height / 2) * 2, height: rowHeight };
}

/** One row per clip: [first frame | last frame]. Used to eyeball continuity-chain drift. */
export async function contactSheet(rows: Array<{ first: string; last: string }>, out: string, cell: Size): Promise<void> {
  const files = rows.flatMap((r) => [r.first, r.last]);
  const inputs = files.flatMap((f) => ["-i", f]);
  const scaled = files.map(
    (_, i) =>
      `[${i}:v]scale=${cell.width}:${cell.height}:force_original_aspect_ratio=decrease,` +
      `pad=${cell.width}:${cell.height}:(ow-iw)/2:(oh-ih)/2,format=rgb24[c${i}]`,
  );
  const layout = files.map((_, i) => `${(i % 2) * cell.width}_${Math.floor(i / 2) * cell.height}`).join("|");
  const labels = files.map((_, i) => `[c${i}]`).join("");
  const filter = `${scaled.join(";")};${labels}xstack=inputs=${files.length}:layout=${layout}[out]`;
  await ffmpeg([...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", out]);
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run test/unit/kenburns.test.ts test/media/frames.test.ts && npm run typecheck`
Expected: PASS (the six Ken Burns renders take a few seconds), `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/media/frames.ts src/media/kenburns.ts src/media/contact-sheet.ts test/unit/kenburns.test.ts test/media/frames.test.ts
git commit -m "feat: add last-frame extraction, Ken Burns renderer and chain contact sheet" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Word-by-word ASS captions

**Files:**
- Create: `src/media/captions.ts`
- Test: `test/unit/captions.test.ts`

**Interfaces:**
- Consumes: `Size` (Task 1).
- Produces: `CaptionWord = { text: string; start: number; end: number }` (global seconds), `CAPTION_FONT = "Montserrat ExtraBold"`, `paginate(words, maxWords?): CaptionWord[][]`, `assTime(sec): string`, `captionStyle(size): { fontSize: number; marginV: number }`, `wordsToAss(words, size): string`.

- [ ] **Step 1: Write the failing test**

`test/unit/captions.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { assTime, captionStyle, paginate, wordsToAss } from "../../src/media/captions.js";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("paginate", () => {
  it("groups up to three words and breaks after punctuation", () => {
    const words = ["one", "two,", "three", "four", "five", "six", "seven."].map((t, i) => w(t, i, i + 1));
    expect(paginate(words).map((p) => p.map((x) => x.text))).toEqual([
      ["one", "two,"],
      ["three", "four", "five"],
      ["six", "seven."],
    ]);
  });
});

describe("assTime", () => {
  it("formats H:MM:SS.cc", () => {
    expect(assTime(65.237)).toBe("0:01:05.24");
    expect(assTime(3600)).toBe("1:00:00.00");
    expect(assTime(-1)).toBe("0:00:00.00");
  });
});

describe("captionStyle", () => {
  it("scales with the output size", () => {
    expect(captionStyle({ width: 1080, height: 1920 })).toEqual({ fontSize: 81, marginV: 576 });
    expect(captionStyle({ width: 1920, height: 1080 })).toEqual({ fontSize: 59, marginV: 130 });
  });
});

describe("wordsToAss", () => {
  const ass = wordsToAss(
    [w("one", 0, 0.4), w("two", 0.4, 0.8), w("three.", 0.8, 1.2), w("{four}", 1.5, 1.9)],
    { width: 1080, height: 1920 },
  );
  const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

  it("declares the play resolution and bundled font", () => {
    expect(ass).toContain("PlayResX: 1080\nPlayResY: 1920");
    expect(ass).toContain("Style: Word,Montserrat ExtraBold,81,");
  });

  it("emits one event per word with the active word highlighted", () => {
    expect(dialogues).toHaveLength(4);
    expect(dialogues[0]).toBe("Dialogue: 0,0:00:00.00,0:00:00.40,Word,,0,0,0,,{\\c&H00E5FF&}ONE{\\c&HFFFFFF&} TWO THREE.");
    expect(dialogues[1]).toBe("Dialogue: 0,0:00:00.40,0:00:00.80,Word,,0,0,0,,ONE {\\c&H00E5FF&}TWO{\\c&HFFFFFF&} THREE.");
  });

  it("ends the last word of a page at its own end and strips override braces", () => {
    expect(dialogues[2]).toBe("Dialogue: 0,0:00:00.80,0:00:01.20,Word,,0,0,0,,ONE TWO {\\c&H00E5FF&}THREE.{\\c&HFFFFFF&}");
    expect(dialogues[3]).toBe("Dialogue: 0,0:00:01.50,0:00:01.90,Word,,0,0,0,,{\\c&H00E5FF&}FOUR{\\c&HFFFFFF&}");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/captions.test.ts`
Expected: FAIL — cannot resolve `../../src/media/captions.js`.

- [ ] **Step 3: Implement `src/media/captions.ts`**

```ts
import type { Size } from "../config.js";

export type CaptionWord = { text: string; start: number; end: number };

export const CAPTION_FONT = "Montserrat ExtraBold";
const HIGHLIGHT = "&H00E5FF&"; // ASS colours are BGR: this is yellow (255, 229, 0)
const BASE = "&HFFFFFF&";
const BREAK_AFTER = /[.,!?;:]$/;
const MIN_EVENT_SEC = 0.04;

export function paginate(words: CaptionWord[], maxWords = 3): CaptionWord[][] {
  const pages: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  for (const word of words) {
    current.push(word);
    if (current.length >= maxWords || BREAK_AFTER.test(word.text)) {
      pages.push(current);
      current = [];
    }
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

export function captionStyle(size: Size): { fontSize: number; marginV: number } {
  return size.height > size.width
    ? { fontSize: Math.round(size.width * 0.075), marginV: Math.round(size.height * 0.3) }
    : { fontSize: Math.round(size.height * 0.055), marginV: Math.round(size.height * 0.12) };
}

const clean = (text: string) => text.replace(/[{}\\]/g, "").toUpperCase();

export function wordsToAss(words: CaptionWord[], size: Size): string {
  const { fontSize, marginV } = captionStyle(size);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${size.width}`,
    `PlayResY: ${size.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Word,${CAPTION_FONT},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,6,0,2,60,60,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  for (const page of paginate(words)) {
    page.forEach((word, i) => {
      const next = page[i + 1];
      const end = Math.max(next ? next.start : word.end, word.start + MIN_EVENT_SEC);
      const text = page
        .map((p, j) => (j === i ? `{\\c${HIGHLIGHT}}${clean(p.text)}{\\c${BASE}}` : clean(p.text)))
        .join(" ");
      events.push(`Dialogue: 0,${assTime(word.start)},${assTime(end)},Word,,0,0,0,,${text}`);
    });
  }
  return `${[...header, ...events].join("\n")}\n`;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/unit/captions.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/media/captions.ts test/unit/captions.test.ts
git commit -m "feat: add word-by-word highlighted ASS caption generator" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Final assembly (concat, BGM ducking, captions burn-in, loudness)

**Files:**
- Create: `src/media/assemble.ts`
- Test: `test/unit/assemble.test.ts`, `test/media/assemble.test.ts`

**Interfaces:**
- Consumes: `ffmpeg` (Task 3); `wordsToAss` (Task 7) in tests.
- Produces: `concatVideos(inputs, out)`, `concatAudio(inputs, out)`, `quoteFilterPath(p): string`, `finalizeFilter(o: { captions: string; fontsDir: string; hasBgm: boolean; totalSec: number }): string`, `FinalizeOptions`, `finalize(o: FinalizeOptions): Promise<void>`.

- [ ] **Step 1: Write the failing unit test**

`test/unit/assemble.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { finalizeFilter, quoteFilterPath } from "../../src/media/assemble.js";

describe("finalizeFilter", () => {
  const base = { captions: "/r/captions.ass", fontsDir: "/p/assets/fonts", totalSec: 91 / 30 };

  it("burns captions and loudness-normalizes narration padded to the exact length", () => {
    const f = finalizeFilter({ ...base, hasBgm: false });
    expect(f).toBe(
      "[0:v]ass='/r/captions.ass':fontsdir='/p/assets/fonts'[v];" +
        "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad,atrim=end=3.033333[a]",
    );
  });

  it("ducks background music under the narration", () => {
    const f = finalizeFilter({ ...base, hasBgm: true });
    expect(f).toContain("[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.35[b]");
    expect(f).toContain("[b][n1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[d]");
    expect(f).toContain("[n2][d]amix=inputs=2:duration=first:normalize=0,loudnorm=");
  });
});

describe("quoteFilterPath", () => {
  it("quotes paths and rejects single quotes", () => {
    expect(quoteFilterPath("/a b/c.ass")).toBe("'/a b/c.ass'");
    expect(() => quoteFilterPath("/it's/c.ass")).toThrow(/quote/);
  });
});
```

- [ ] **Step 2: Write the failing media test**

`test/media/assemble.test.ts`:
```ts
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { concatAudio, concatVideos, finalize } from "../../src/media/assemble.js";
import { wordsToAss } from "../../src/media/captions.js";
import { countFrames, probeDuration, streamDuration } from "../../src/media/ffmpeg.js";
import { makeAudio, makeVideo, tempDir } from "../helpers/media.js";

const size = { width: 180, height: 320 };

async function scenes(dir: string) {
  const v1 = join(dir, "v1.mp4");
  const v2 = join(dir, "v2.mp4");
  await makeVideo(v1, { frames: 45, fps: 30, ...size });
  await makeVideo(v2, { frames: 46, fps: 30, ...size });
  const a1 = join(dir, "a1.wav");
  const a2 = join(dir, "a2.wav");
  await makeAudio(a1, [{ tone: 1.5 }]);
  await makeAudio(a2, [{ tone: 1.53, freq: 660 }]);
  const video = join(dir, "video.mp4");
  const narration = join(dir, "narration.wav");
  await concatVideos([v1, v2], video);
  await concatAudio([a1, a2], narration);
  const captions = join(dir, "captions.ass");
  await writeFile(captions, wordsToAss([{ text: "hello", start: 0, end: 1 }, { text: "world", start: 1.5, end: 2.5 }], size));
  return { video, narration, captions };
}

describe("assemble", () => {
  it("concatenates scenes exactly", async () => {
    const dir = await tempDir();
    const { video, narration } = await scenes(dir);
    expect(await countFrames(video)).toBe(91);
    expect(await probeDuration(narration)).toBeCloseTo(3.03, 2);
  });

  for (const withBgm of [false, true]) {
    it(`finalizes with A/V within one frame (bgm: ${withBgm})`, async () => {
      const dir = await tempDir();
      const parts = await scenes(dir);
      let bgm: string | undefined;
      if (withBgm) {
        bgm = join(dir, "bgm.wav");
        await makeAudio(bgm, [{ tone: 1, freq: 220 }]);
      }
      const out = join(dir, "final.mp4");
      await finalize({ ...parts, bgm, fontsDir: resolve("assets/fonts"), totalFrames: 91, fps: 30, out });
      expect(await countFrames(out)).toBe(91);
      const drift = Math.abs((await streamDuration(out, "v")) - (await streamDuration(out, "a")));
      expect(drift).toBeLessThanOrEqual(1 / 30);
    });
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/assemble.test.ts test/media/assemble.test.ts`
Expected: FAIL — cannot resolve `../../src/media/assemble.js`.

- [ ] **Step 4: Implement `src/media/assemble.ts`**

```ts
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ffmpeg } from "./ffmpeg.js";

/** Stream-copy concat; all inputs come from the fit stage with identical encoder settings. */
export async function concatVideos(inputs: string[], out: string): Promise<void> {
  const list = `${out}.txt`;
  await writeFile(list, inputs.map((p) => `file '${resolve(p).replace(/'/g, "'\\''")}'`).join("\n"));
  try {
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
  } finally {
    await rm(list, { force: true });
  }
}

/** Sample-accurate audio concat to 48 kHz mono PCM. */
export async function concatAudio(inputs: string[], out: string): Promise<void> {
  const args = inputs.flatMap((p) => ["-i", p]);
  const labels = inputs.map((_, i) => `[${i}:a]`).join("");
  const filter = `${labels}concat=n=${inputs.length}:v=0:a=1[a]`;
  await ffmpeg([...args, "-filter_complex", filter, "-map", "[a]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
}

export function quoteFilterPath(p: string): string {
  if (p.includes("'")) throw new Error(`path cannot be used in an ffmpeg filter because it contains a quote: ${p}`);
  return `'${p}'`;
}

export function finalizeFilter(o: { captions: string; fontsDir: string; hasBgm: boolean; totalSec: number }): string {
  const video = `[0:v]ass=${quoteFilterPath(o.captions)}:fontsdir=${quoteFilterPath(o.fontsDir)}[v]`;
  const tail = `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad,atrim=end=${o.totalSec.toFixed(6)}[a]`;
  const stereo = "aformat=sample_rates=48000:channel_layouts=stereo";
  if (!o.hasBgm) return `${video};[1:a]${stereo},${tail}`;
  return [
    video,
    `[1:a]${stereo},asplit=2[n1][n2]`,
    `[2:a]${stereo},volume=0.35[b]`,
    "[b][n1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[d]",
    `[n2][d]amix=inputs=2:duration=first:normalize=0,${tail}`,
  ].join(";");
}

export type FinalizeOptions = {
  video: string;
  narration: string;
  captions: string;
  fontsDir: string;
  bgm?: string;
  totalFrames: number;
  fps: number;
  out: string;
};

/** Video length is pinned with -frames:v and audio with apad+atrim, so neither relies on -shortest. */
export async function finalize(o: FinalizeOptions): Promise<void> {
  const inputs = ["-i", o.video, "-i", o.narration, ...(o.bgm ? ["-stream_loop", "-1", "-i", o.bgm] : [])];
  const filter = finalizeFilter({
    captions: o.captions,
    fontsDir: o.fontsDir,
    hasBgm: Boolean(o.bgm),
    totalSec: o.totalFrames / o.fps,
  });
  await ffmpeg([
    ...inputs, "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
    "-frames:v", String(o.totalFrames),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(o.fps),
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", o.out,
  ]);
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/unit/assemble.test.ts test/media/assemble.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/media/assemble.ts test/unit/assemble.test.ts test/media/assemble.test.ts
git commit -m "feat: add final assembly with caption burn-in, BGM ducking and loudnorm" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Provider contracts, retry, download, test fakes

**Files:**
- Create: `src/providers/types.ts`, `src/providers/retry.ts`, `src/providers/download.ts`, `test/fakes/providers.ts`
- Test: `test/unit/retry-download.test.ts`

**Interfaces:**
- Consumes: `Aspect` (Task 1); `WordTiming`, `Camera` (Task 2); `makeAudio`, `makeImage`, `makeVideo` (Task 3).
- Produces (types.ts): `ScriptRequest`, `LlmProvider`, `SpeakRequest`, `TtsProvider`, `ImageRequest`, `ImageProvider`, `VideoRequest`, `VideoProvider`, `Providers`.
- Produces (retry.ts): `TIMEOUTS = { llm: 60_000, tts: 60_000, image: 120_000, video: 600_000 }`, `RetryOptions`, `withRetry<T>(label, fn, opts): Promise<T>`.
- Produces (download.ts): `download(url, dest): Promise<void>` (supports `file://`).
- Produces (fakes): `fakeScript(sceneCount, opts?)`, `FakeLlm`, `FakeTts`, `FakeImage`, `FakeVideo` — each with a public `calls` array.

- [ ] **Step 1: Implement `src/providers/types.ts`** (types only; exercised by every later test)

```ts
import type { Aspect } from "../config.js";
import type { WordTiming } from "../manifest/schema.js";

export type ScriptRequest = { topic: string; sceneCount: number; aspect: Aspect; feedback?: string };
export interface LlmProvider {
  /** Returns parsed JSON; the script stage validates it against the Script schema. */
  generateScript(req: ScriptRequest): Promise<unknown>;
}

export type SpeakRequest = { text: string; previousText?: string; nextText?: string; voiceId: string };
export interface TtsProvider {
  /** `audio` is MP3 bytes; `words` are relative to the start of that audio. */
  speak(req: SpeakRequest): Promise<{ audio: Buffer; words: WordTiming[] }>;
}

export type ImageRequest = { prompt: string; width: number; height: number; seed?: number };
export interface ImageProvider {
  generate(req: ImageRequest): Promise<{ url: string; seed: number }>;
}

export type VideoRequest = { imagePath: string; prompt: string; durationSec: 5 | 10 };
export interface VideoProvider {
  imageToVideo(req: VideoRequest): Promise<{ url: string }>;
}

export type Providers = { llm: LlmProvider; tts: TtsProvider; image: ImageProvider; video: VideoProvider };
```

- [ ] **Step 2: Write the failing test**

`test/unit/retry-download.test.ts`:
```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { download } from "../../src/providers/download.js";
import { withRetry } from "../../src/providers/retry.js";

const noSleep = async () => {};

describe("withRetry", () => {
  it("retries with exponential backoff and returns the first success", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const result = await withRetry(
      "x",
      async () => {
        if (++n < 3) throw new Error("boom");
        return 42;
      },
      { timeoutMs: 1000, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe(42);
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("reports the label and last error after the final attempt", async () => {
    await expect(
      withRetry("tts scene 1", async () => Promise.reject(new Error("nope")), { timeoutMs: 1000, sleep: noSleep }),
    ).rejects.toThrow("tts scene 1 failed after 3 attempts: nope");
  });

  it("times out calls that never settle", async () => {
    await expect(
      withRetry("video", () => new Promise<never>(() => {}), { timeoutMs: 20, attempts: 2, sleep: noSleep }),
    ).rejects.toThrow(/video failed after 2 attempts: timed out after 20 ms/);
  });
});

describe("download", () => {
  it("copies file:// URLs into nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    const src = join(dir, "src.bin");
    await writeFile(src, "data");
    const dest = join(dir, "a", "b", "out.bin");
    await download(pathToFileURL(src).href, dest);
    expect(await readFile(dest, "utf8")).toBe("data");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/retry-download.test.ts`
Expected: FAIL — cannot resolve `../../src/providers/download.js`.

- [ ] **Step 4: Implement `src/providers/retry.ts`**

```ts
export const TIMEOUTS = { llm: 60_000, tts: 60_000, image: 120_000, video: 600_000 } as const;

export type RetryOptions = {
  attempts?: number;
  timeoutMs: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Races each attempt against a timeout so a hung provider call can never stall the pipeline. */
export async function withRetry<T>(label: string, fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { attempts = 3, timeoutMs, baseDelayMs = 2000, sleep = realSleep } = opts;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      return await Promise.race([fn(), timeout]);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed after ${attempts} attempts: ${message}`);
}
```

- [ ] **Step 5: Implement `src/providers/download.ts`**

```ts
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Downloads immediately: provider-hosted URLs expire, so the local copy is the source of truth. */
export async function download(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), dest);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download of ${url} failed: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
```

- [ ] **Step 6: Implement the fakes `test/fakes/providers.ts`**

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Camera } from "../../src/manifest/schema.js";
import type {
  ImageProvider, ImageRequest, LlmProvider, ScriptRequest, SpeakRequest, TtsProvider, VideoProvider, VideoRequest,
} from "../../src/providers/types.js";
import { makeAudio, makeImage, makeVideo } from "../helpers/media.js";

export type Shot = "continue" | "cut";

export function fakeScript(sceneCount: number, opts: { shots?: Shot[]; cameras?: Camera[] } = {}) {
  return {
    title: "Fake run",
    styleBible: { artStyle: "flat test pattern", characters: "a red fox", palette: "teal, orange" },
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      narration: `Scene ${i + 1} says hello. Then it pauses and continues.`,
      imagePrompt: `image ${i + 1}`,
      motionPrompt: `motion ${i + 1}`,
      shot: opts.shots?.[i] ?? (i === 0 ? "cut" : "continue"),
      camera: opts.cameras?.[i] ?? "zoom_in",
    })),
  };
}

export class FakeLlm implements LlmProvider {
  calls: ScriptRequest[] = [];
  constructor(private readonly respond: (req: ScriptRequest, callNo: number) => unknown) {}
  async generateScript(req: ScriptRequest): Promise<unknown> {
    this.calls.push(req);
    return this.respond(req, this.calls.length);
  }
}

/** Speaks the first half of the words, pauses 0.5 s, then speaks the rest, so silence removal has work to do. */
export class FakeTts implements TtsProvider {
  calls: SpeakRequest[] = [];
  constructor(private readonly dir: string) {}
  async speak(req: SpeakRequest) {
    this.calls.push(req);
    const words = req.text.split(/\s+/).filter(Boolean);
    const half = Math.ceil(words.length / 2);
    const per = 0.25;
    const path = join(this.dir, `tts_${this.calls.length}.mp3`);
    await makeAudio(path, [{ tone: half * per }, { silence: 0.5 }, { tone: (words.length - half) * per, freq: 550 }]);
    const timings = words.map((text, i) => {
      const start = i < half ? i * per : half * per + 0.5 + (i - half) * per;
      return { text, start, end: start + per - 0.02 };
    });
    return { audio: await readFile(path), words: timings };
  }
}

const COLORS = ["0x3366aa", "0xaa6633", "0x33aa66", "0xaa3366", "0x6633aa"];

export class FakeImage implements ImageProvider {
  calls: ImageRequest[] = [];
  constructor(private readonly dir: string) {}
  async generate(req: ImageRequest) {
    const n = this.calls.push(req);
    const path = join(this.dir, `img_${n}.png`);
    await makeImage(path, { width: req.width, height: req.height, color: COLORS[n % COLORS.length] });
    return { url: pathToFileURL(path).href, seed: 1000 + n };
  }
}

/** Every call renders a differently tinted clip, so last-frame hashes change on regeneration (like a real API). */
export class FakeVideo implements VideoProvider {
  calls: VideoRequest[] = [];
  failWhen?: (req: VideoRequest) => boolean;
  constructor(private readonly dir: string) {}
  async imageToVideo(req: VideoRequest) {
    const n = this.calls.push(req);
    if (this.failWhen?.(req)) throw new Error("fake video failure");
    const path = join(this.dir, `vid_${n}.mp4`);
    await makeVideo(path, { seconds: req.durationSec, fps: 24, width: 180, height: 320, hue: (n * 47) % 360 });
    return { url: pathToFileURL(path).href };
  }
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run test/unit/retry-download.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0 (this also typechecks the fakes against the interfaces).

- [ ] **Step 8: Commit**

```bash
git add src/providers test/fakes test/unit/retry-download.test.ts
git commit -m "feat: add provider contracts, retry with timeouts, downloads and test fakes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Real provider adapters (Gemini, ElevenLabs, fal)

**Files:**
- Create: `src/providers/gemini.ts`, `src/providers/elevenlabs.ts`, `src/providers/fal.ts`
- Test: `test/unit/providers.test.ts`

**Interfaces:**
- Consumes: provider types (Task 9); `Script`, `MAX_NARRATION_WORDS`, `WordTiming` (Task 2).
- Produces (gemini.ts): `scriptJsonSchema(): Record<string, unknown>`, `buildScriptPrompt(req): string`, `class GeminiLlm(apiKey, model)` with `generateScript(req)` and `checkModel()`.
- Produces (elevenlabs.ts): `Alignment`, `wordsFromAlignment(a): WordTiming[]`, `class ElevenLabsTts(apiKey, model, fetchImpl?)` with `speak(req)` and `checkVoice(voiceId)`.
- Produces (fal.ts): `FalLike`, `createFal(apiKey): FalLike`, `class FalImage(fal, model)`, `class FalVideo(fal, model)`, `checkFal(fal): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`test/unit/providers.test.ts`:
```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ElevenLabsTts, wordsFromAlignment } from "../../src/providers/elevenlabs.js";
import { FalImage, type FalLike, FalVideo } from "../../src/providers/fal.js";
import { buildScriptPrompt, scriptJsonSchema } from "../../src/providers/gemini.js";

describe("gemini prompt and schema", () => {
  it("asks for the exact scene count and word cap", () => {
    const p = buildScriptPrompt({ topic: "octopus intelligence", sceneCount: 5, aspect: "9:16" });
    expect(p).toContain('"octopus intelligence"');
    expect(p).toContain("exactly 5 scenes");
    expect(p).toContain("at most 22 words");
    expect(p).toContain("vertical 9:16");
    expect(p).not.toContain("rejected");
  });

  it("appends validation feedback on retry", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "16:9", feedback: "scene 2 narration has 30 words" });
    expect(p).toContain("rejected");
    expect(p).toContain("scene 2 narration has 30 words");
  });

  it("produces a JSON schema without $schema", () => {
    const s = scriptJsonSchema() as { $schema?: string; properties: { scenes: { maxItems: number } } };
    expect(s.$schema).toBeUndefined();
    expect(s.properties.scenes.maxItems).toBe(12);
  });
});

describe("elevenlabs", () => {
  const alignment = {
    characters: [..."Hi  yo"],
    character_start_times_seconds: [0, 0.1, 0.2, 0.25, 0.3, 0.4],
    character_end_times_seconds: [0.1, 0.2, 0.25, 0.3, 0.4, 0.5],
  };

  it("builds words from character alignment", () => {
    expect(wordsFromAlignment(alignment)).toEqual([
      { text: "Hi", start: 0, end: 0.2 },
      { text: "yo", start: 0.3, end: 0.5 },
    ]);
  });

  it("calls with-timestamps with continuity context and decodes the audio", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ audio_base64: Buffer.from("MP3").toString("base64"), alignment, normalized_alignment: null }),
        { status: 200 },
      );
    }) as typeof fetch;
    const tts = new ElevenLabsTts("key", "eleven_multilingual_v2", fakeFetch);
    const r = await tts.speak({ text: "Hi  yo", previousText: "Before.", voiceId: "voice/1" });
    expect(calls[0].url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1/with-timestamps?output_format=mp3_44100_128",
    );
    expect(calls[0].body).toEqual({ text: "Hi  yo", model_id: "eleven_multilingual_v2", previous_text: "Before." });
    expect(r.audio.toString()).toBe("MP3");
    expect(r.words).toHaveLength(2);
  });

  it("surfaces HTTP errors", async () => {
    const fakeFetch = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    await expect(new ElevenLabsTts("k", "m", fakeFetch).speak({ text: "x", voiceId: "v" })).rejects.toThrow(
      "ElevenLabs TTS HTTP 401: bad key",
    );
  });
});

describe("fal adapters", () => {
  function fakeFal() {
    const calls: Array<{ id: string; input: Record<string, unknown> }> = [];
    const uploads: Blob[] = [];
    const fal = {
      subscribe: async (id: string, opts: { input: Record<string, unknown> }) => {
        calls.push({ id, input: opts.input });
        const data = id.includes("flux")
          ? { images: [{ url: "https://fal.media/k.png" }], seed: 77 }
          : { video: { url: "https://fal.media/c.mp4" } };
        return { requestId: "r1", data };
      },
      storage: { upload: async (b: Blob) => (uploads.push(b), "https://fal.media/up.png") },
    } as unknown as FalLike;
    return { fal, calls, uploads };
  }

  it("generates a Flux image at an explicit size", async () => {
    const { fal, calls } = fakeFal();
    const r = await new FalImage(fal, "fal-ai/flux/dev").generate({ prompt: "p", width: 1088, height: 1920 });
    expect(r).toEqual({ url: "https://fal.media/k.png", seed: 77 });
    expect(calls[0].input).toMatchObject({ prompt: "p", image_size: { width: 1088, height: 1920 }, num_images: 1 });
    expect(calls[0].input).not.toHaveProperty("seed");
  });

  it("uploads the chain image and requests the clip length as a string", async () => {
    const { fal, calls, uploads } = fakeFal();
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    const img = join(dir, "last.png");
    await writeFile(img, "png-bytes");
    const r = await new FalVideo(fal, "fal-ai/kling-video/v2.1/standard/image-to-video").imageToVideo({
      imagePath: img,
      prompt: "move",
      durationSec: 10,
    });
    expect(r).toEqual({ url: "https://fal.media/c.mp4" });
    expect(uploads).toHaveLength(1);
    expect(calls[0].input).toMatchObject({ image_url: "https://fal.media/up.png", prompt: "move", duration: "10" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/providers.test.ts`
Expected: FAIL — cannot resolve `../../src/providers/elevenlabs.js`.

- [ ] **Step 3: Implement `src/providers/gemini.ts`**

```ts
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { MAX_NARRATION_WORDS, Script } from "../manifest/schema.js";
import type { LlmProvider, ScriptRequest } from "./types.js";

/** Gemini's responseJsonSchema takes plain JSON Schema; drop the draft marker zod adds. */
export function scriptJsonSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(Script) as Record<string, unknown>;
  return schema;
}

export function buildScriptPrompt(req: ScriptRequest): string {
  const orientation =
    req.aspect === "9:16"
      ? "vertical 9:16 (subject centered, tall composition)"
      : "horizontal 16:9 (wide cinematic composition)";
  return [
    `You are writing a faceless short-form video about: "${req.topic}".`,
    `Return exactly ${req.sceneCount} scenes.`,
    "",
    "Rules:",
    `- narration: the spoken voiceover for the scene, at most ${MAX_NARRATION_WORDS} words, plain text, no stage directions, emojis or hashtags.`,
    "- All narrations together read as one continuous script with a strong hook in scene 1.",
    "- styleBible.artStyle: one visual style used by every scene (medium, lighting, lens, mood).",
    '- styleBible.characters: a precise, reusable description of every recurring character (age, clothing, hair, colors), or "none".',
    "- styleBible.palette: 3-5 dominant colors.",
    `- imagePrompt: what a single still frame of the scene shows, ${orientation}. Do not repeat the style bible; it is added automatically. Never ask for text, captions, logos or watermarks.`,
    "- motionPrompt: camera movement plus subject motion during the scene in one or two sentences, physically plausible for a 5-10 second clip.",
    '- shot: "continue" if the scene happens in the same place and moment as the previous scene and should flow on from its last frame; "cut" for a new location, time or framing. Scene 1 must be "cut".',
    "- camera: the programmatic camera move used if this scene is rendered from a still image.",
    ...(req.feedback ? ["", "Your previous answer was rejected for these reasons. Fix them:", req.feedback] : []),
  ].join("\n");
}

export class GeminiLlm implements LlmProvider {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateScript(req: ScriptRequest): Promise<unknown> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: buildScriptPrompt(req),
      config: { responseMimeType: "application/json", responseJsonSchema: scriptJsonSchema(), temperature: 0.9 },
    });
    const text = res.text;
    if (!text) throw new Error("Gemini returned an empty response");
    return JSON.parse(text);
  }

  /** Fails with a clear API error when the model id is retired or misspelled. */
  async checkModel(): Promise<void> {
    await this.ai.models.get({ model: this.model });
  }
}
```

- [ ] **Step 4: Implement `src/providers/elevenlabs.ts`**

```ts
import type { WordTiming } from "../manifest/schema.js";
import type { SpeakRequest, TtsProvider } from "./types.js";

const API = "https://api.elevenlabs.io";

export type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

export function wordsFromAlignment(a: Alignment): WordTiming[] {
  const words: WordTiming[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (text) words.push({ text, start, end });
      text = "";
      return;
    }
    if (!text) start = a.character_start_times_seconds[i];
    text += ch;
    end = a.character_end_times_seconds[i];
  });
  if (text) words.push({ text, start, end });
  return words;
}

export class ElevenLabsTts implements TtsProvider {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async speak(req: SpeakRequest): Promise<{ audio: Buffer; words: WordTiming[] }> {
    const url = `${API}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        text: req.text,
        model_id: this.model,
        previous_text: req.previousText,
        next_text: req.nextText,
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      audio_base64: string;
      alignment: Alignment | null;
      normalized_alignment: Alignment | null;
    };
    const alignment = body.alignment ?? body.normalized_alignment;
    if (!alignment) throw new Error("ElevenLabs response contained no alignment");
    return { audio: Buffer.from(body.audio_base64, "base64"), words: wordsFromAlignment(alignment) };
  }

  async checkVoice(voiceId: string): Promise<void> {
    const res = await this.fetchImpl(`${API}/v1/voices/${encodeURIComponent(voiceId)}`, {
      headers: { "xi-api-key": this.apiKey },
    });
    if (!res.ok) throw new Error(`ElevenLabs voice ${voiceId}: HTTP ${res.status} ${await res.text()}`);
  }
}
```

- [ ] **Step 5: Implement `src/providers/fal.ts`**

```ts
import { readFile } from "node:fs/promises";
import { createFalClient, type FalClient } from "@fal-ai/client";
import type { ImageProvider, ImageRequest, VideoProvider, VideoRequest } from "./types.js";

export type FalLike = Pick<FalClient, "subscribe" | "storage">;

export function createFal(apiKey: string): FalLike {
  return createFalClient({ credentials: apiKey });
}

export class FalImage implements ImageProvider {
  constructor(
    private readonly fal: FalLike,
    readonly model: string,
  ) {}

  async generate(req: ImageRequest): Promise<{ url: string; seed: number }> {
    const result = await this.fal.subscribe(this.model, {
      input: {
        prompt: req.prompt,
        image_size: { width: req.width, height: req.height },
        num_images: 1,
        num_inference_steps: 28,
        guidance_scale: 3.5,
        output_format: "png",
        enable_safety_checker: true,
        ...(req.seed === undefined ? {} : { seed: req.seed }),
      },
    });
    const data = result.data as { images: Array<{ url: string }>; seed: number };
    return { url: data.images[0].url, seed: data.seed };
  }
}

/** Kling v2.1 takes its aspect ratio from the input image. */
export class FalVideo implements VideoProvider {
  constructor(
    private readonly fal: FalLike,
    readonly model: string,
  ) {}

  async imageToVideo(req: VideoRequest): Promise<{ url: string }> {
    const image = new Blob([await readFile(req.imagePath)], { type: "image/png" });
    const imageUrl = await this.fal.storage.upload(image);
    const result = await this.fal.subscribe(this.model, {
      input: {
        image_url: imageUrl,
        prompt: req.prompt,
        duration: String(req.durationSec),
        negative_prompt: "blur, distortion, low quality, text, watermark, morphing faces",
        cfg_scale: 0.5,
      },
    });
    return { url: (result.data as { video: { url: string } }).video.url };
  }
}

/** Validates the key with a free storage upload (no generation cost). */
export async function checkFal(fal: FalLike): Promise<void> {
  await fal.storage.upload(new Blob(["flowchain doctor"], { type: "text/plain" }));
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/unit/providers.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0. If `tsc` rejects `readFile(...)` as a `BlobPart` (newer `@types/node`), wrap it: `new Blob([new Uint8Array(await readFile(req.imagePath))], …)`.

- [ ] **Step 7: Commit**

```bash
git add src/providers/gemini.ts src/providers/elevenlabs.ts src/providers/fal.ts test/unit/providers.test.ts
git commit -m "feat: add Gemini, ElevenLabs and fal.ai provider adapters" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Pipeline engine (planning, checkpoints, caching, ledger)

**Files:**
- Create: `src/stages/types.ts`, `src/pipeline.ts`
- Test: `test/unit/pipeline-engine.test.ts`

**Interfaces:**
- Consumes: `Prices`, `Size` (Task 1); `Manifest`, `StageName`, `StageRecord`, `inputHash`, `saveManifest` (Task 2); `Providers` (Task 9); `round4` (Task 1).
- Produces (stages/types.ts): `StageContext`, `Dep`, `Stage` (see code).
- Produces (pipeline.ts): `WorkItem`, `Plan`, `ConfirmFn`, `RunOptions`, `MEDIA_CHECKPOINT = "keyframes"`, `RunAborted`, `targets(stage, m)`, `computeHash(ctx, stage, scene?)`, `isFresh(ctx, stage, scene?)`, `planRun(ctx, stages, forced?)`, `formatPlan(plan, label)`, `runPipeline(ctx, stages, opts)`.

- [ ] **Step 1: Implement `src/stages/types.ts`** (types only)

```ts
import type { Prices, Size } from "../config.js";
import type { Manifest, StageName } from "../manifest/schema.js";
import type { Providers } from "../providers/types.js";

export type StageContext = {
  /** Absolute run directory; every path stored in the manifest is relative to it. */
  dir: string;
  manifest: Manifest;
  providers: Providers;
  prices: Prices;
  size: Size;
  keyframeSize: Size;
  fps: number;
  fontsDir: string;
  /** Base backoff for provider retries (tests use 0). */
  retryDelayMs: number;
  log: (message: string) => void;
};

export type Dep = { stage: StageName; scene?: number };

export interface Stage {
  name: StageName;
  perScene: boolean;
  paid: boolean;
  /** Per-scene stages only: whether this scene needs the stage at all (default: every scene). */
  appliesTo?(m: Manifest, scene: number): boolean;
  /** Upstream (stage, scene) pairs. Used only to price cascades before running; execution relies on hashes. */
  deps(m: Manifest, scene?: number): Dep[];
  /** Everything the output depends on, including upstream file hashes. Throws if upstream data is missing. */
  inputsFor(ctx: StageContext, scene?: number): Promise<unknown>;
  /** Run-relative files that must exist for a cache hit. */
  outputsFor(m: Manifest, scene?: number): string[];
  /** Must not throw when upstream data is missing; fall back to conservative assumptions. */
  estimateCostUsd(ctx: StageContext, scene?: number): number;
  /** Does the work, updates ctx.manifest and returns the USD to record in the ledger. */
  run(ctx: StageContext, scene?: number): Promise<number>;
}
```

- [ ] **Step 2: Write the failing test**

`test/unit/pipeline-engine.test.ts`:
```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Prices } from "../../src/config.js";
import { fileSha256 } from "../../src/manifest/hash.js";
import { createManifest, loadManifest } from "../../src/manifest/store.js";
import { formatPlan, planRun, RunAborted, type RunOptions, runPipeline } from "../../src/pipeline.js";
import type { Providers } from "../../src/providers/types.js";
import type { Stage, StageContext } from "../../src/stages/types.js";

type Toy = { log: string[]; failKeyframe?: number };

/** Three toy stages that write random content, so re-running one changes its downstream hashes. */
function toyStages(toy: Toy): Stage[] {
  const write = (ctx: StageContext, rel: string) => writeFile(join(ctx.dir, rel), `${rel}:${Math.random()}`);
  return [
    {
      name: "script", perScene: false, paid: true,
      deps: () => [],
      inputsFor: async (ctx) => ({ topic: ctx.manifest.request.topic }),
      outputsFor: () => ["script.txt"],
      estimateCostUsd: () => 0.01,
      run: async (ctx) => (toy.log.push("script"), await write(ctx, "script.txt"), 0.01),
    },
    {
      name: "tts", perScene: true, paid: true,
      deps: () => [{ stage: "script" }],
      inputsFor: async (ctx) => ({ script: await fileSha256(join(ctx.dir, "script.txt")) }),
      outputsFor: (_m, i) => [`tts_${i}.txt`],
      estimateCostUsd: () => 0.1,
      run: async (ctx, i) => (toy.log.push(`tts${i}`), await write(ctx, `tts_${i}.txt`), 0.1),
    },
    {
      name: "keyframes", perScene: true, paid: true,
      deps: (_m, i) => [{ stage: "tts", scene: i }],
      inputsFor: async (ctx, i) => ({ tts: await fileSha256(join(ctx.dir, `tts_${i}.txt`)) }),
      outputsFor: (_m, i) => [`kf_${i}.txt`],
      estimateCostUsd: () => 1,
      run: async (ctx, i) => {
        toy.log.push(`kf${i}`);
        if (toy.failKeyframe === i) throw new Error("kf boom");
        await write(ctx, `kf_${i}.txt`);
        return 1;
      },
    },
  ];
}

async function toyContext(): Promise<StageContext> {
  const dir = await mkdtemp(join(tmpdir(), "fc-pipe-"));
  const manifest = createManifest(
    "toy",
    { topic: "t", aspect: "9:16", sceneCount: 3, modes: [1, 1, 1], voiceId: "v" },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );
  return {
    dir, manifest, providers: {} as Providers, prices: Prices.parse({}),
    size: { width: 180, height: 320 }, keyframeSize: { width: 192, height: 336 },
    fps: 30, fontsDir: "", retryDelayMs: 0, log: () => {},
  };
}

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("runPipeline", () => {
  it("runs everything once, records results and the ledger", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    await runPipeline(ctx, toyStages(toy), auto);
    expect(toy.log).toEqual(["script", "tts0", "tts1", "tts2", "kf0", "kf1", "kf2"]);
    const saved = await loadManifest(ctx.dir);
    expect(saved.ledger).toHaveLength(7);
    expect(saved.ledger.reduce((a, e) => a + e.usd, 0)).toBeCloseTo(3.31, 6);
    expect(saved.runStages.script?.status).toBe("done");
    expect(saved.scenes[2].stages.keyframes?.status).toBe("done");
  });

  it("skips fresh work on a second run", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    await runPipeline(ctx, toyStages(toy), auto);
    await runPipeline(ctx, toyStages(toy), auto);
    expect(toy.log).toHaveLength(7);
  });

  it("re-runs a scene and its dependents after a nonce bump, and prices that cascade up front", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const stages = toyStages(toy);
    await runPipeline(ctx, stages, auto);
    ctx.manifest.scenes[1].nonces.tts = 1;
    const plan = await planRun(ctx, stages);
    expect(plan.items).toEqual([
      { stage: "tts", scene: 1, costUsd: 0.1 },
      { stage: "keyframes", scene: 1, costUsd: 1 },
    ]);
    expect(plan.totalUsd).toBeCloseTo(1.1, 6);
    await runPipeline(ctx, stages, auto);
    expect(toy.log.slice(7)).toEqual(["tts1", "kf1"]);
  });

  it("saves a failed record and resumes from it", async () => {
    const toy: Toy = { log: [], failKeyframe: 1 };
    const ctx = await toyContext();
    await expect(runPipeline(ctx, toyStages(toy), auto)).rejects.toThrow("kf boom");
    const saved = await loadManifest(ctx.dir);
    expect(saved.scenes[1].stages.keyframes).toMatchObject({ status: "failed", error: "kf boom" });
    expect(toy.log).not.toContain("kf2");
    toy.failKeyframe = undefined;
    await runPipeline(ctx, toyStages(toy), auto);
    expect(toy.log.slice(-2)).toEqual(["kf1", "kf2"]);
  });

  it("asks before exceeding the budget and runs nothing when declined", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const confirm = vi.fn(async () => false);
    await expect(runPipeline(ctx, toyStages(toy), { budgetUsd: 1, confirm })).rejects.toBeInstanceOf(RunAborted);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ totalUsd: 3.31 }), "over the $1.00 budget");
    expect(toy.log).toEqual([]);
  });

  it("--yes skips confirmation", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const confirm = vi.fn(async () => false);
    await runPipeline(ctx, toyStages(toy), { budgetUsd: 0, confirm, yes: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(toy.log).toHaveLength(7);
  });

  it("a reroll confirms paid work even under budget, once", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const stages = toyStages(toy);
    await runPipeline(ctx, stages, auto);
    ctx.manifest.scenes[0].nonces.tts = 1;
    const confirm = vi.fn(async () => true);
    await runPipeline(ctx, stages, { budgetUsd: 100, confirm, reroll: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.anything(), "reroll");
  });

  it("--from forces that stage and every later one", async () => {
    const toy: Toy = { log: [] };
    const ctx = await toyContext();
    const stages = toyStages(toy);
    await runPipeline(ctx, stages, auto);
    await runPipeline(ctx, stages, { ...auto, from: "tts" });
    expect(toy.log.slice(7)).toEqual(["tts0", "tts1", "tts2", "kf0", "kf1", "kf2"]);
  });
});

describe("formatPlan", () => {
  it("renders one row per step with 1-based scene numbers", () => {
    const text = formatPlan(
      {
        items: [
          { stage: "script", costUsd: 0.0055 },
          { stage: "clips", scene: 1, costUsd: 0.25 },
          { stage: "fit", scene: 1, costUsd: 0 },
        ],
        totalUsd: 0.256,
      },
      "Plan",
    );
    expect(text).toBe(
      [
        "Plan: 3 step(s), estimated $0.26",
        "  script    run         $0.0055",
        "  clips     scene 2     $0.2500",
        "  fit       scene 2     free",
      ].join("\n"),
    );
  });

  it("says when there is nothing to do", () => {
    expect(formatPlan({ items: [], totalUsd: 0 }, "Media plan")).toBe("Media plan: nothing to do");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/pipeline-engine.test.ts`
Expected: FAIL — cannot resolve `../../src/pipeline.js`.

- [ ] **Step 4: Implement `src/pipeline.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { round4 } from "./cost.js";
import { inputHash } from "./manifest/hash.js";
import type { Manifest, StageName, StageRecord } from "./manifest/schema.js";
import { saveManifest } from "./manifest/store.js";
import type { Stage, StageContext } from "./stages/types.js";

export type WorkItem = { stage: StageName; scene?: number; costUsd: number };
export type Plan = { items: WorkItem[]; totalUsd: number };
export type ConfirmFn = (plan: Plan, reason: string) => Promise<boolean>;
export type RunOptions = {
  budgetUsd: number;
  confirm: ConfirmFn;
  yes?: boolean;
  /** Rerolls confirm whenever paid work is planned, regardless of budget. */
  reroll?: boolean;
  /** Force this stage and every later stage to re-run. */
  from?: StageName;
  onPlan?: (plan: Plan, label: string) => void;
};

/** Second confirmation point: script and audio exist here, so every remaining estimate is exact. */
export const MEDIA_CHECKPOINT: StageName = "keyframes";

export class RunAborted extends Error {
  constructor() {
    super("Run aborted: the estimated cost was not confirmed.");
  }
}

const key = (stage: StageName, scene?: number) => `${stage}:${scene ?? "-"}`;

function getRecord(m: Manifest, stage: StageName, scene?: number): StageRecord | undefined {
  return scene === undefined ? m.runStages[stage] : m.scenes[scene].stages[stage];
}

function setRecord(m: Manifest, stage: StageName, scene: number | undefined, record: StageRecord): void {
  if (scene === undefined) m.runStages[stage] = record;
  else m.scenes[scene].stages[stage] = record;
}

export function targets(stage: Stage, m: Manifest): Array<number | undefined> {
  if (!stage.perScene) return [undefined];
  return m.scenes.map((s) => s.idx).filter((i) => stage.appliesTo?.(m, i) ?? true);
}

export async function computeHash(ctx: StageContext, stage: Stage, scene?: number): Promise<string> {
  const nonce = scene === undefined ? 0 : (ctx.manifest.scenes[scene].nonces[stage.name] ?? 0);
  return inputHash(stage.name, { nonce, inputs: await stage.inputsFor(ctx, scene) });
}

/** Cache hit: last attempt succeeded, inputs are unchanged and every output file still exists. */
export async function isFresh(ctx: StageContext, stage: Stage, scene?: number): Promise<boolean> {
  const record = getRecord(ctx.manifest, stage.name, scene);
  if (record?.status !== "done") return false;
  let hash: string;
  try {
    hash = await computeHash(ctx, stage, scene);
  } catch {
    return false;
  }
  if (hash !== record.inputHash) return false;
  return stage.outputsFor(ctx.manifest, scene).every((p) => existsSync(join(ctx.dir, p)));
}

function forcedStages(stages: Stage[], from?: StageName): Set<StageName> {
  if (!from) return new Set();
  const i = stages.findIndex((s) => s.name === from);
  if (i < 0) throw new Error(`unknown stage "${from}"`);
  return new Set(stages.slice(i).map((s) => s.name));
}

/** Predicts which (stage, scene) pairs will run, propagating "will run" down each stage's deps(). */
export async function planRun(ctx: StageContext, stages: Stage[], forced = new Set<StageName>()): Promise<Plan> {
  const willRun = new Set<string>();
  const items: WorkItem[] = [];
  for (const stage of stages) {
    for (const scene of targets(stage, ctx.manifest)) {
      const upstream = stage.deps(ctx.manifest, scene).some((d) => willRun.has(key(d.stage, d.scene)));
      if (forced.has(stage.name) || upstream || !(await isFresh(ctx, stage, scene))) {
        willRun.add(key(stage.name, scene));
        items.push({ stage: stage.name, scene, costUsd: stage.paid ? stage.estimateCostUsd(ctx, scene) : 0 });
      }
    }
  }
  return { items, totalUsd: round4(items.reduce((sum, i) => sum + i.costUsd, 0)) };
}

export function formatPlan(plan: Plan, label: string): string {
  if (plan.items.length === 0) return `${label}: nothing to do`;
  const rows = plan.items.map((i) => {
    const where = i.scene === undefined ? "run" : `scene ${i.scene + 1}`;
    const cost = i.costUsd > 0 ? `$${i.costUsd.toFixed(4)}` : "free";
    return `  ${i.stage.padEnd(10)}${where.padEnd(12)}${cost}`;
  });
  return [`${label}: ${plan.items.length} step(s), estimated $${plan.totalUsd.toFixed(2)}`, ...rows].join("\n");
}

async function execute(ctx: StageContext, stage: Stage, scene?: number): Promise<void> {
  const hash = await computeHash(ctx, stage, scene);
  ctx.log(`▶ ${stage.name}${scene === undefined ? "" : ` scene ${scene + 1}`}`);
  let cost: number;
  try {
    cost = await stage.run(ctx, scene);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    setRecord(ctx.manifest, stage.name, scene, {
      status: "failed", inputHash: hash, costUsd: 0, finishedAt: new Date().toISOString(), error,
    });
    await saveManifest(ctx.dir, ctx.manifest);
    throw err;
  }
  const at = new Date().toISOString();
  setRecord(ctx.manifest, stage.name, scene, { status: "done", inputHash: hash, costUsd: cost, finishedAt: at });
  if (cost > 0) ctx.manifest.ledger.push({ stage: stage.name, scene, usd: cost, at });
  await saveManifest(ctx.dir, ctx.manifest);
}

export async function runPipeline(ctx: StageContext, stages: Stage[], opts: RunOptions): Promise<void> {
  const forced = forcedStages(stages, opts.from);
  let accepted = 0;
  const checkpoint = async (remaining: Stage[], label: string) => {
    const plan = await planRun(ctx, remaining, forced);
    opts.onPlan?.(plan, label);
    ctx.log(formatPlan(plan, label));
    const needsConfirm = opts.reroll ? plan.totalUsd > 0 : plan.totalUsd > opts.budgetUsd;
    if (needsConfirm && plan.totalUsd > accepted + 0.01 && !opts.yes) {
      const reason = opts.reroll ? "reroll" : `over the $${opts.budgetUsd.toFixed(2)} budget`;
      if (!(await opts.confirm(plan, reason))) throw new RunAborted();
    }
    accepted = Math.max(accepted, plan.totalUsd);
  };

  await checkpoint(stages, "Plan");
  for (const [i, stage] of stages.entries()) {
    if (i > 0 && stage.name === MEDIA_CHECKPOINT) await checkpoint(stages.slice(i), "Media plan");
    for (const scene of targets(stage, ctx.manifest)) {
      if (!forced.has(stage.name) && (await isFresh(ctx, stage, scene))) continue;
      await execute(ctx, stage, scene);
    }
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/unit/pipeline-engine.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/stages/types.ts src/pipeline.ts test/unit/pipeline-engine.test.ts
git commit -m "feat: add cache-aware pipeline engine with cost checkpoints and ledger" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Stages `script`, `tts`, `silence`

**Files:**
- Create: `src/stages/paths.ts`, `src/stages/require.ts`, `src/stages/script.ts`, `src/stages/tts.ts`, `src/stages/silence.ts`, `test/helpers/context.ts`
- Test: `test/stages/audio-stages.test.ts`

**Interfaces:**
- Consumes: `Stage`, `StageContext` (Task 11); `runPipeline` (Task 11, in tests); `withRetry`, `TIMEOUTS` (Task 9); `removeSilence`, `remapTimings` (Task 4); `scriptCost`, `ttsCost`, `FALLBACK_NARRATION_CHARS` (Task 1); fakes (Task 9).
- Produces (paths.ts): `paths` (all run-relative file names), `abs(ctx, rel)`, `outPath(ctx, rel): Promise<string>` (creates the parent dir).
- Produces (require.ts): `requireScript(m)`, `requireTts(scene)`, `requireAudio(scene)`, `requireClip(scene)`, `requireFitted(scene)`.
- Produces: `countWords(text)`, `validateScript(raw, sceneCount)`, `scriptStage`, `ttsStage`, `SILENCE_PARAMS`, `silenceStage`.
- Produces (test/helpers/context.ts): `makeTestContext(opts?)` → `{ ctx, fakes, logs, dir }`.

- [ ] **Step 1: Implement `src/stages/paths.ts` and `src/stages/require.ts`**

`src/stages/paths.ts`:
```ts
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StageContext } from "./types.js";

const n = (scene: number) => String(scene + 1).padStart(2, "0");

/** Run-relative file layout. File names are 1-based to match what humans see in the CLI. */
export const paths = {
  script: "script.json",
  rawAudio: (i: number) => `audio/scene_${n(i)}.raw.mp3`,
  audio: (i: number) => `audio/scene_${n(i)}.wav`,
  keyframe: (i: number) => `images/keyframe_${n(i)}.png`,
  clip: (i: number) => `clips/clip_${n(i)}.mp4`,
  firstFrame: (i: number) => `frames/first_${n(i)}.png`,
  lastFrame: (i: number) => `frames/last_${n(i)}.png`,
  fitted: (i: number) => `fitted/scene_${n(i)}.mp4`,
  captions: "captions.ass",
  video: "video.mp4",
  narration: "narration.wav",
  final: "final.mp4",
  chain: "chain.png",
} as const;

export const abs = (ctx: StageContext, rel: string): string => join(ctx.dir, rel);

export async function outPath(ctx: StageContext, rel: string): Promise<string> {
  const p = abs(ctx, rel);
  await mkdir(dirname(p), { recursive: true });
  return p;
}
```

`src/stages/require.ts`:
```ts
import type { Manifest, SceneState, Script } from "../manifest/schema.js";

type Field<K extends keyof SceneState> = NonNullable<SceneState[K]>;

function need<K extends keyof SceneState>(scene: SceneState, key: K, what: string): Field<K> {
  const value = scene[key];
  if (value === undefined || value === null) throw new Error(`scene ${scene.idx + 1} has no ${what} yet`);
  return value as Field<K>;
}

export function requireScript(m: Manifest): Script {
  if (!m.script) throw new Error("the script has not been generated yet");
  return m.script;
}

export const requireTts = (s: SceneState) => need(s, "tts", "voiceover");
export const requireAudio = (s: SceneState) => need(s, "audio", "trimmed audio");
export const requireClip = (s: SceneState) => need(s, "clip", "clip");
export const requireFitted = (s: SceneState) => need(s, "fitted", "fitted clip");
```

- [ ] **Step 2: Implement the shared test context `test/helpers/context.ts`**

```ts
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Prices } from "../../src/config.js";
import type { Mode } from "../../src/manifest/schema.js";
import { createManifest } from "../../src/manifest/store.js";
import type { StageContext } from "../../src/stages/types.js";
import { FakeImage, FakeLlm, FakeTts, FakeVideo, fakeScript, type Shot } from "../fakes/providers.js";
import { tempDir } from "./media.js";

export type TestContextOptions = {
  modes?: Mode[];
  shots?: Shot[];
  /** Overrides the LLM answer; receives the 1-based call number. */
  script?: (callNo: number) => unknown;
  bgm?: string;
};

/** A run in a temp dir with fake providers and small output sizes so media steps stay fast. */
export async function makeTestContext(opts: TestContextOptions = {}) {
  const modes = opts.modes ?? [1, 1];
  const dir = await tempDir("flowchain-run-");
  const fakesDir = join(dir, "_fakes");
  await mkdir(fakesDir);
  const fakes = {
    llm: new FakeLlm((req, callNo) =>
      opts.script ? opts.script(callNo) : fakeScript(req.sceneCount, { shots: opts.shots }),
    ),
    tts: new FakeTts(fakesDir),
    image: new FakeImage(fakesDir),
    video: new FakeVideo(fakesDir),
  };
  const manifest = createManifest(
    "test-run",
    { topic: "foxes", aspect: "9:16", sceneCount: modes.length, modes, voiceId: "voice-1", bgm: opts.bgm },
    { llm: "fake-llm", tts: "fake-tts", image: "fake-image", video: "fake-video" },
  );
  const logs: string[] = [];
  const ctx: StageContext = {
    dir,
    manifest,
    providers: fakes,
    prices: Prices.parse({}),
    size: { width: 180, height: 320 },
    keyframeSize: { width: 192, height: 336 },
    fps: 30,
    fontsDir: resolve("assets/fonts"),
    retryDelayMs: 0,
    log: (m) => logs.push(m),
  };
  return { ctx, fakes, logs, dir };
}
```

- [ ] **Step 3: Write the failing test**

`test/stages/audio-stages.test.ts`:
```ts
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scriptCost, ttsCost } from "../../src/cost.js";
import { probeDuration } from "../../src/media/ffmpeg.js";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { abs, paths } from "../../src/stages/paths.js";
import { scriptStage, validateScript } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("validateScript", () => {
  it("accepts a well-formed script", () => {
    expect(validateScript(fakeScript(2), 2).ok).toBe(true);
  });

  it("rejects the wrong scene count and over-long narration", () => {
    const raw = fakeScript(2);
    raw.scenes[1].narration = Array.from({ length: 23 }, () => "word").join(" ");
    const v = validateScript(raw, 3);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.problems).toContain("expected exactly 3 scenes, got 2");
      expect(v.problems).toContain("scene 2 narration has 23 words (max 22)");
    }
  });

  it("reports schema errors with their path", () => {
    const v = validateScript({ title: "x", styleBible: {}, scenes: [] }, 1);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems.join("\n")).toMatch(/styleBible\.artStyle/);
  });
});

describe("script stage", () => {
  it("stores a validated script and records its cost", async () => {
    const { ctx } = await makeTestContext();
    await runPipeline(ctx, [scriptStage], auto);
    expect(ctx.manifest.script?.title).toBe("Fake run");
    expect(existsSync(abs(ctx, paths.script))).toBe(true);
    expect(ctx.manifest.ledger.map((e) => e.usd)).toEqual([scriptCost(ctx.prices)]);
  });

  it("retries once with the validation problems as feedback", async () => {
    const { ctx, fakes } = await makeTestContext({
      script: (n) => (n === 1 ? fakeScript(1) : fakeScript(2)),
    });
    await runPipeline(ctx, [scriptStage], auto);
    expect(fakes.llm.calls).toHaveLength(2);
    expect(fakes.llm.calls[1].feedback).toContain("expected exactly 2 scenes, got 1");
    expect(ctx.manifest.ledger[0].usd).toBeCloseTo(2 * scriptCost(ctx.prices), 6);
  });

  it("fails after two invalid answers", async () => {
    const { ctx } = await makeTestContext({ script: () => ({ nope: true }) });
    await expect(runPipeline(ctx, [scriptStage], auto)).rejects.toThrow(/failed validation twice/);
    expect(ctx.manifest.runStages.script?.status).toBe("failed");
  });
});

describe("tts and silence stages", () => {
  it("voices each scene with neighbour context, then trims the pause and remaps words", async () => {
    const { ctx, fakes } = await makeTestContext();
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage], auto);
    const script = ctx.manifest.script!;
    expect(fakes.tts.calls[0]).toMatchObject({ voiceId: "voice-1", nextText: script.scenes[1].narration });
    expect(fakes.tts.calls[0].previousText).toBeUndefined();
    expect(fakes.tts.calls[1].previousText).toBe(script.scenes[0].narration);

    for (const scene of ctx.manifest.scenes) {
      const audio = scene.audio!;
      const raw = await probeDuration(abs(ctx, scene.tts!.raw));
      expect(audio.removedSec).toBeGreaterThan(0.25);
      expect(audio.removedSec).toBeLessThan(0.45);
      // MP3 container duration includes encoder padding (~25 ms), so compare loosely
      expect(audio.duration).toBeCloseTo(raw - audio.removedSec, 1);
      expect(audio.words).toHaveLength(9);
      expect(audio.words.at(-1)!.end).toBeLessThanOrEqual(audio.duration + 0.05);
    }
    const ttsEntries = ctx.manifest.ledger.filter((e) => e.stage === "tts");
    expect(ttsEntries.map((e) => e.usd)).toEqual(script.scenes.map((s) => ttsCost(ctx.prices, s.narration.length)));
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/stages/audio-stages.test.ts`
Expected: FAIL — cannot resolve `../../src/stages/script.js`.

- [ ] **Step 5: Implement `src/stages/script.ts`**

```ts
import { writeFile } from "node:fs/promises";
import { scriptCost } from "../cost.js";
import { MAX_NARRATION_WORDS, Script } from "../manifest/schema.js";
import { TIMEOUTS, withRetry } from "../providers/retry.js";
import { outPath, paths } from "./paths.js";
import type { Stage } from "./types.js";

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export type ScriptValidation = { ok: true; script: Script } | { ok: false; problems: string[] };

export function validateScript(raw: unknown, sceneCount: number): ScriptValidation {
  const parsed = Script.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const problems: string[] = [];
  if (parsed.data.scenes.length !== sceneCount) {
    problems.push(`expected exactly ${sceneCount} scenes, got ${parsed.data.scenes.length}`);
  }
  parsed.data.scenes.forEach((s, i) => {
    const words = countWords(s.narration);
    if (words > MAX_NARRATION_WORDS) {
      problems.push(`scene ${i + 1} narration has ${words} words (max ${MAX_NARRATION_WORDS})`);
    }
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, script: parsed.data };
}

export const scriptStage: Stage = {
  name: "script",
  perScene: false,
  paid: true,
  deps: () => [],
  inputsFor: async (ctx) => {
    const { topic, sceneCount, aspect } = ctx.manifest.request;
    return { model: ctx.manifest.models.llm, topic, sceneCount, aspect };
  },
  outputsFor: () => [paths.script],
  estimateCostUsd: (ctx) => scriptCost(ctx.prices),
  async run(ctx) {
    const { topic, sceneCount, aspect } = ctx.manifest.request;
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await withRetry(
        "script generation",
        () => ctx.providers.llm.generateScript({ topic, sceneCount, aspect, feedback }),
        { timeoutMs: TIMEOUTS.llm, baseDelayMs: ctx.retryDelayMs },
      );
      const result = validateScript(raw, sceneCount);
      if (result.ok) {
        ctx.manifest.script = result.script;
        await writeFile(await outPath(ctx, paths.script), `${JSON.stringify(result.script, null, 2)}\n`);
        return scriptCost(ctx.prices) * attempt;
      }
      feedback = result.problems.join("\n");
      ctx.log(`script rejected:\n${feedback}`);
    }
    throw new Error(`the script failed validation twice:\n${feedback}`);
  },
};
```

- [ ] **Step 6: Implement `src/stages/tts.ts`**

```ts
import { writeFile } from "node:fs/promises";
import { FALLBACK_NARRATION_CHARS, ttsCost } from "../cost.js";
import type { Manifest } from "../manifest/schema.js";
import { TIMEOUTS, withRetry } from "../providers/retry.js";
import { outPath, paths } from "./paths.js";
import { requireScript } from "./require.js";
import type { Stage } from "./types.js";

function speech(m: Manifest, i: number) {
  const scenes = requireScript(m).scenes;
  return {
    text: scenes[i].narration,
    previousText: scenes[i - 1]?.narration,
    nextText: scenes[i + 1]?.narration,
    voiceId: m.request.voiceId,
  };
}

export const ttsStage: Stage = {
  name: "tts",
  perScene: true,
  paid: true,
  deps: () => [{ stage: "script" }],
  inputsFor: async (ctx, scene) => ({ model: ctx.manifest.models.tts, ...speech(ctx.manifest, scene!) }),
  outputsFor: (_m, scene) => [paths.rawAudio(scene!)],
  estimateCostUsd: (ctx, scene) =>
    ttsCost(ctx.prices, ctx.manifest.script?.scenes[scene!]?.narration.length ?? FALLBACK_NARRATION_CHARS),
  async run(ctx, scene) {
    const i = scene!;
    const req = speech(ctx.manifest, i);
    const result = await withRetry(`tts scene ${i + 1}`, () => ctx.providers.tts.speak(req), {
      timeoutMs: TIMEOUTS.tts,
      baseDelayMs: ctx.retryDelayMs,
    });
    await writeFile(await outPath(ctx, paths.rawAudio(i)), result.audio);
    ctx.manifest.scenes[i].tts = { raw: paths.rawAudio(i), words: result.words };
    return ttsCost(ctx.prices, req.text.length);
  },
};
```

- [ ] **Step 7: Implement `src/stages/silence.ts`**

```ts
import { fileSha256 } from "../manifest/hash.js";
import { remapTimings, removeSilence } from "../media/silence.js";
import { abs, outPath, paths } from "./paths.js";
import { requireTts } from "./require.js";
import type { Stage } from "./types.js";

export const SILENCE_PARAMS = { noiseDb: -30, minSilence: 0.2, padding: 0.08 };

export const silenceStage: Stage = {
  name: "silence",
  perScene: true,
  paid: false,
  deps: (_m, scene) => [{ stage: "tts", scene }],
  inputsFor: async (ctx, scene) => {
    const tts = requireTts(ctx.manifest.scenes[scene!]);
    return { raw: await fileSha256(abs(ctx, tts.raw)), words: tts.words, params: SILENCE_PARAMS };
  },
  outputsFor: (_m, scene) => [paths.audio(scene!)],
  estimateCostUsd: () => 0,
  async run(ctx, scene) {
    const i = scene!;
    const tts = requireTts(ctx.manifest.scenes[i]);
    const result = await removeSilence(abs(ctx, tts.raw), await outPath(ctx, paths.audio(i)), SILENCE_PARAMS);
    ctx.manifest.scenes[i].audio = {
      path: paths.audio(i),
      duration: result.duration,
      words: remapTimings(tts.words, result.keep),
      removedSec: result.removedSec,
    };
    return 0;
  },
};
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run test/stages/audio-stages.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/stages test/helpers/context.ts test/stages/audio-stages.test.ts
git commit -m "feat: add script, tts and silence stages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Stages `keyframes` and `clips` (the continuity chain)

**Files:**
- Create: `src/stages/visual.ts`, `src/stages/keyframes.ts`, `src/stages/clips.ts`
- Test: `test/stages/visual-stages.test.ts`

**Interfaces:**
- Consumes: Task 11 types; Task 12 `paths`, `abs`, `outPath`, `requireScript`, `requireAudio`; `download`, `withRetry`, `TIMEOUTS` (Task 9); `extractLastFrame` (Task 6); `renderKenBurns` (Task 6); `probeDuration` (Task 3); `sceneFrameCounts`, `requestedSec` (Task 5); `imageCost`, `videoCost` (Task 1); `fileSha256` (Task 2).
- Produces (visual.ts): `needsKeyframe(m, i): boolean`, `chainImagePath(m, i): string`, `imagePrompt(script, i)`, `motionPrompt(script, i)`, `sceneFrames(m, fps): number[]`.
- Produces: `keyframesStage`, `clipsStage`.

- [ ] **Step 1: Write the failing test**

`test/stages/visual-stages.test.ts`:
```ts
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { imageCost } from "../../src/cost.js";
import { fileSha256 } from "../../src/manifest/hash.js";
import { createManifest } from "../../src/manifest/store.js";
import type { Mode } from "../../src/manifest/schema.js";
import { countFrames } from "../../src/media/ffmpeg.js";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { clipsStage } from "../../src/stages/clips.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { abs, paths } from "../../src/stages/paths.js";
import { scriptStage } from "../../src/stages/script.js";
import { silenceStage } from "../../src/stages/silence.js";
import { ttsStage } from "../../src/stages/tts.js";
import { imagePrompt, motionPrompt, needsKeyframe, sceneFrames } from "../../src/stages/visual.js";
import { fakeScript, type Shot } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };
const models = { llm: "l", tts: "t", image: "i", video: "v" };

function manifestWith(modes: Mode[], shots?: Shot[]) {
  const m = createManifest("r", { topic: "t", aspect: "9:16", sceneCount: modes.length, modes, voiceId: "v" }, models);
  if (shots) m.script = fakeScript(modes.length, { shots });
  return m;
}

describe("needsKeyframe", () => {
  it("starts a fresh chain at scene 1, Mode 2 scenes, scenes after Mode 2, and cuts", () => {
    const m = manifestWith([1, 1, 2, 1, 1], ["cut", "continue", "continue", "continue", "cut"]);
    expect(m.scenes.map((s) => needsKeyframe(m, s.idx))).toEqual([true, false, true, true, true]);
  });

  it("works before the script exists", () => {
    const m = manifestWith([1, 1, 2, 1]);
    expect(m.scenes.map((s) => needsKeyframe(m, s.idx))).toEqual([true, false, true, true]);
  });
});

describe("prompts", () => {
  const script = fakeScript(1);
  it("prefixes the image prompt with the style bible", () => {
    expect(imagePrompt(script, 0)).toBe("flat test pattern. a red fox. Palette: teal, orange. image 1");
  });
  it("suffixes the motion prompt with the style bible", () => {
    expect(motionPrompt(script, 0)).toBe("motion 1. Keep style consistent: flat test pattern. a red fox.");
  });
});

describe("keyframes and clips stages", () => {
  it("chains Mode 1 clips through last frames and renders Mode 2 locally", async () => {
    const { ctx, fakes } = await makeTestContext({
      modes: [1, 1, 2, 1],
      shots: ["cut", "continue", "continue", "continue"],
    });
    await runPipeline(ctx, [scriptStage, ttsStage, silenceStage, keyframesStage, clipsStage], auto);

    expect(fakes.image.calls).toHaveLength(3);
    expect(fakes.image.calls[0]).toMatchObject({ width: 192, height: 336, prompt: imagePrompt(ctx.manifest.script!, 0) });
    expect(fakes.video.calls.map((c) => basename(c.imagePath))).toEqual([
      "keyframe_01.png",
      "last_01.png",
      "keyframe_04.png",
    ]);
    expect(fakes.video.calls.map((c) => c.durationSec)).toEqual([5, 5, 5]);
    expect(fakes.video.calls[1].prompt).toBe(motionPrompt(ctx.manifest.script!, 1));

    expect(await countFrames(abs(ctx, paths.clip(2)))).toBe(sceneFrames(ctx.manifest, 30)[2]);
    for (const i of [0, 1, 3]) {
      const last = ctx.manifest.scenes[i].lastFrame!;
      expect(last.sha256).toBe(await fileSha256(abs(ctx, last.path)));
    }
    expect(ctx.manifest.scenes[2].lastFrame).toBeUndefined();

    const paid = (stage: string) => ctx.manifest.ledger.filter((e) => e.stage === stage).map((e) => e.usd);
    expect(paid("keyframes")).toEqual([0, 2, 3].map(() => imageCost(ctx.prices, ctx.keyframeSize)));
    expect(paid("clips")).toEqual([0.25, 0.25, 0.25]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stages/visual-stages.test.ts`
Expected: FAIL — cannot resolve `../../src/stages/clips.js`.

- [ ] **Step 3: Implement `src/stages/visual.ts`**

```ts
import type { Manifest, Script } from "../manifest/schema.js";
import { sceneFrameCounts } from "../media/timeline.js";
import { paths } from "./paths.js";
import { requireAudio } from "./require.js";

/** Spec §4.1. Before the script exists, `shot` is unknown and treated as "continue". */
export function needsKeyframe(m: Manifest, i: number): boolean {
  if (i === 0 || m.scenes[i].mode === 2 || m.scenes[i - 1].mode === 2) return true;
  return m.script?.scenes[i]?.shot === "cut";
}

/** The image a scene's clip starts from: its own keyframe, or the previous clip's last frame. */
export function chainImagePath(m: Manifest, i: number): string {
  return needsKeyframe(m, i) ? paths.keyframe(i) : paths.lastFrame(i - 1);
}

export function imagePrompt(script: Script, i: number): string {
  const b = script.styleBible;
  return `${b.artStyle}. ${b.characters}. Palette: ${b.palette}. ${script.scenes[i].imagePrompt}`;
}

export function motionPrompt(script: Script, i: number): string {
  const b = script.styleBible;
  return `${script.scenes[i].motionPrompt}. Keep style consistent: ${b.artStyle}. ${b.characters}.`;
}

export function sceneFrames(m: Manifest, fps: number): number[] {
  return sceneFrameCounts(
    m.scenes.map((s) => requireAudio(s).duration),
    fps,
  );
}
```

- [ ] **Step 4: Implement `src/stages/keyframes.ts`**

```ts
import { imageCost } from "../cost.js";
import { download } from "../providers/download.js";
import { TIMEOUTS, withRetry } from "../providers/retry.js";
import { outPath, paths } from "./paths.js";
import { requireScript } from "./require.js";
import type { Stage } from "./types.js";
import { imagePrompt, needsKeyframe } from "./visual.js";

export const keyframesStage: Stage = {
  name: "keyframes",
  perScene: true,
  paid: true,
  appliesTo: needsKeyframe,
  deps: () => [{ stage: "script" }],
  inputsFor: async (ctx, scene) => ({
    model: ctx.manifest.models.image,
    prompt: imagePrompt(requireScript(ctx.manifest), scene!),
    size: ctx.keyframeSize,
  }),
  outputsFor: (_m, scene) => [paths.keyframe(scene!)],
  estimateCostUsd: (ctx) => imageCost(ctx.prices, ctx.keyframeSize),
  async run(ctx, scene) {
    const i = scene!;
    const prompt = imagePrompt(requireScript(ctx.manifest), i);
    const result = await withRetry(
      `keyframe scene ${i + 1}`,
      () => ctx.providers.image.generate({ prompt, ...ctx.keyframeSize }),
      { timeoutMs: TIMEOUTS.image, baseDelayMs: ctx.retryDelayMs },
    );
    await download(result.url, await outPath(ctx, paths.keyframe(i)));
    ctx.manifest.scenes[i].keyframe = { path: paths.keyframe(i), seed: result.seed, sourceUrl: result.url };
    return imageCost(ctx.prices, ctx.keyframeSize);
  },
};
```

- [ ] **Step 5: Implement `src/stages/clips.ts`**

```ts
import { videoCost } from "../cost.js";
import { fileSha256 } from "../manifest/hash.js";
import { probeDuration } from "../media/ffmpeg.js";
import { extractLastFrame } from "../media/frames.js";
import { renderKenBurns } from "../media/kenburns.js";
import { requestedSec } from "../media/timeline.js";
import { download } from "../providers/download.js";
import { TIMEOUTS, withRetry } from "../providers/retry.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireScript } from "./require.js";
import type { Dep, Stage } from "./types.js";
import { chainImagePath, motionPrompt, needsKeyframe, sceneFrames } from "./visual.js";

export const clipsStage: Stage = {
  name: "clips",
  perScene: true,
  paid: true,
  deps: (m, scene) => {
    const i = scene!;
    const deps: Dep[] = [{ stage: "script" }, { stage: "silence", scene: i }];
    deps.push(needsKeyframe(m, i) ? { stage: "keyframes", scene: i } : { stage: "clips", scene: i - 1 });
    // A Mode 2 clip is rendered at frames_i, which depends on every earlier scene's duration.
    if (m.scenes[i].mode === 2) for (let k = 0; k < i; k++) deps.push({ stage: "silence", scene: k });
    return deps;
  },
  async inputsFor(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const script = requireScript(m);
    const imageSha = await fileSha256(abs(ctx, chainImagePath(m, i)));
    if (m.scenes[i].mode === 1) {
      return {
        mode: 1,
        model: m.models.video,
        prompt: motionPrompt(script, i),
        requestedSec: requestedSec(requireAudio(m.scenes[i]).duration),
        imageSha,
      };
    }
    return {
      mode: 2,
      camera: script.scenes[i].camera,
      frames: sceneFrames(m, ctx.fps)[i],
      size: ctx.size,
      fps: ctx.fps,
      imageSha,
    };
  },
  outputsFor: (m, scene) =>
    m.scenes[scene!].mode === 1 ? [paths.clip(scene!), paths.lastFrame(scene!)] : [paths.clip(scene!)],
  estimateCostUsd(ctx, scene) {
    const s = ctx.manifest.scenes[scene!];
    if (s.mode === 2) return 0;
    return videoCost(ctx.prices, s.audio ? requestedSec(s.audio.duration) : 10);
  },
  async run(ctx, scene) {
    const i = scene!;
    const m = ctx.manifest;
    const state = m.scenes[i];
    const script = requireScript(m);
    const out = await outPath(ctx, paths.clip(i));
    const chainImage = abs(ctx, chainImagePath(m, i));

    if (state.mode === 2) {
      const frames = sceneFrames(m, ctx.fps)[i];
      await renderKenBurns(chainImage, out, script.scenes[i].camera, frames, ctx.size, ctx.fps);
      state.clip = { path: paths.clip(i), duration: frames / ctx.fps };
      state.lastFrame = undefined;
      return 0;
    }

    const seconds = requestedSec(requireAudio(state).duration);
    const result = await withRetry(
      `clip scene ${i + 1}`,
      () => ctx.providers.video.imageToVideo({ imagePath: chainImage, prompt: motionPrompt(script, i), durationSec: seconds }),
      { timeoutMs: TIMEOUTS.video, baseDelayMs: ctx.retryDelayMs },
    );
    await download(result.url, out);
    const last = await outPath(ctx, paths.lastFrame(i));
    await extractLastFrame(out, last);
    state.clip = { path: paths.clip(i), sourceUrl: result.url, duration: await probeDuration(out), requestedSec: seconds };
    state.lastFrame = { path: paths.lastFrame(i), sha256: await fileSha256(last) };
    return videoCost(ctx.prices, seconds);
  },
};
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/stages/visual-stages.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/stages/visual.ts src/stages/keyframes.ts src/stages/clips.ts test/stages/visual-stages.test.ts
git commit -m "feat: add keyframe and clip stages with last-frame continuity chain" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Stages `fit`, `captions`, `assemble` and the stage registry

**Files:**
- Create: `src/stages/fit.ts`, `src/stages/captions.ts`, `src/stages/assemble.ts`, `src/stages/index.ts`
- Test: `test/stages/output-stages.test.ts`

**Interfaces:**
- Consumes: Tasks 5–8 media functions; Task 12/13 helpers (`paths`, `abs`, `outPath`, `require*`, `sceneFrames`).
- Produces: `fitStage`, `globalWords(m): CaptionWord[]`, `captionsStage`, `assembleStage`, `STAGES: Stage[]` (pipeline order).

- [ ] **Step 1: Write the failing test**

`test/stages/output-stages.test.ts`:
```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { cellSize } from "../../src/media/contact-sheet.js";
import { countFrames, probeVideo, streamDuration } from "../../src/media/ffmpeg.js";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { globalWords } from "../../src/stages/captions.js";
import { STAGES } from "../../src/stages/index.js";
import { abs, paths } from "../../src/stages/paths.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("globalWords", () => {
  it("offsets each scene's words by the cumulative audio duration", () => {
    const m = createManifest(
      "r",
      { topic: "t", aspect: "9:16", sceneCount: 2, modes: [1, 1], voiceId: "v" },
      { llm: "l", tts: "t", image: "i", video: "v" },
    );
    m.scenes[0].audio = { path: "a", duration: 1.5, removedSec: 0, words: [{ text: "a", start: 0.1, end: 0.5 }] };
    m.scenes[1].audio = { path: "b", duration: 2, removedSec: 0, words: [{ text: "b", start: 0.2, end: 0.6 }] };
    expect(globalWords(m)).toEqual([
      { text: "a", start: 0.1, end: 0.5 },
      { text: "b", start: 1.7, end: 2.1 },
    ]);
  });
});

describe("full pipeline with fakes", () => {
  it("produces a frame-exact final.mp4, captions and chain.png", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 2] });
    await runPipeline(ctx, STAGES, auto);

    const total = ctx.manifest.scenes.reduce((a, s) => a + s.audio!.duration, 0);
    const frames = Math.round(total * 30);
    const final = abs(ctx, paths.final);
    expect(await countFrames(final)).toBe(frames);
    expect(await probeVideo(final)).toEqual({ width: 180, height: 320, fps: 30 });
    const drift = Math.abs((await streamDuration(final, "v")) - (await streamDuration(final, "a")));
    expect(drift).toBeLessThanOrEqual(1 / 30);
    expect(ctx.manifest.final?.duration).toBeCloseTo(frames / 30, 6);

    const ass = await readFile(abs(ctx, paths.captions), "utf8");
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:"))).toHaveLength(18);

    const cell = cellSize(ctx.size);
    const sheet = await probeVideo(abs(ctx, paths.chain));
    expect({ width: sheet.width, height: sheet.height }).toEqual({ width: cell.width * 2, height: cell.height * 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stages/output-stages.test.ts`
Expected: FAIL — cannot resolve `../../src/stages/captions.js`.

- [ ] **Step 3: Implement `src/stages/fit.ts`**

```ts
import { fileSha256 } from "../manifest/hash.js";
import { applyFit, planFit } from "../media/fit.js";
import { abs, outPath, paths } from "./paths.js";
import { requireClip } from "./require.js";
import type { Stage } from "./types.js";
import { sceneFrames } from "./visual.js";

export const fitStage: Stage = {
  name: "fit",
  perScene: true,
  paid: false,
  // frames_i depends on the durations of every scene up to and including i
  deps: (m, scene) => [
    { stage: "clips", scene },
    ...m.scenes.slice(0, scene! + 1).map((s) => ({ stage: "silence" as const, scene: s.idx })),
  ],
  inputsFor: async (ctx, scene) => ({
    clip: await fileSha256(abs(ctx, paths.clip(scene!))),
    frames: sceneFrames(ctx.manifest, ctx.fps)[scene!],
    size: ctx.size,
    fps: ctx.fps,
  }),
  outputsFor: (_m, scene) => [paths.fitted(scene!)],
  estimateCostUsd: () => 0,
  async run(ctx, scene) {
    const i = scene!;
    const state = ctx.manifest.scenes[i];
    const clip = requireClip(state);
    const frames = sceneFrames(ctx.manifest, ctx.fps)[i];
    const plan = planFit(clip.duration, frames / ctx.fps);
    await applyFit(abs(ctx, clip.path), await outPath(ctx, paths.fitted(i)), plan, frames, ctx.size, ctx.fps);
    state.fitted = { path: paths.fitted(i), frames, plan };
    if (plan.kind !== "trim") ctx.log(`scene ${i + 1}: clip shorter than its audio, fit plan ${JSON.stringify(plan)}`);
    return 0;
  },
};
```

- [ ] **Step 4: Implement `src/stages/captions.ts`**

```ts
import { writeFile } from "node:fs/promises";
import type { Manifest } from "../manifest/schema.js";
import { type CaptionWord, wordsToAss } from "../media/captions.js";
import { audioStarts } from "../media/timeline.js";
import { outPath, paths } from "./paths.js";
import { requireAudio } from "./require.js";
import type { Stage } from "./types.js";

/** Captions follow the speech, so they use cumulative audio starts (≤ ½ frame from the video cuts). */
export function globalWords(m: Manifest): CaptionWord[] {
  const audio = m.scenes.map((s) => requireAudio(s));
  const starts = audioStarts(audio.map((a) => a.duration));
  return audio.flatMap((a, i) => a.words.map((w) => ({ text: w.text, start: w.start + starts[i], end: w.end + starts[i] })));
}

export const captionsStage: Stage = {
  name: "captions",
  perScene: false,
  paid: false,
  deps: (m) => m.scenes.map((s) => ({ stage: "silence" as const, scene: s.idx })),
  inputsFor: async (ctx) => ({ words: globalWords(ctx.manifest), size: ctx.size }),
  outputsFor: () => [paths.captions],
  estimateCostUsd: () => 0,
  async run(ctx) {
    await writeFile(await outPath(ctx, paths.captions), wordsToAss(globalWords(ctx.manifest), ctx.size));
    return 0;
  },
};
```

- [ ] **Step 5: Implement `src/stages/assemble.ts`**

```ts
import { existsSync } from "node:fs";
import { fileSha256 } from "../manifest/hash.js";
import { concatAudio, concatVideos, finalize } from "../media/assemble.js";
import { cellSize, contactSheet } from "../media/contact-sheet.js";
import { extractFrame, extractLastFrame } from "../media/frames.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip, requireFitted } from "./require.js";
import type { Stage, StageContext } from "./types.js";

const shaAll = (ctx: StageContext, rels: string[]) => Promise.all(rels.map((r) => fileSha256(abs(ctx, r))));

/** chain.png: first and last frame of every raw clip, one row per scene. */
async function writeChainSheet(ctx: StageContext): Promise<void> {
  const rows = [];
  for (const scene of ctx.manifest.scenes) {
    const clip = abs(ctx, requireClip(scene).path);
    const first = await outPath(ctx, paths.firstFrame(scene.idx));
    const last = abs(ctx, paths.lastFrame(scene.idx));
    await extractFrame(clip, 0, first);
    if (scene.mode === 2 || !existsSync(last)) await extractLastFrame(clip, await outPath(ctx, paths.lastFrame(scene.idx)));
    rows.push({ first, last });
  }
  await contactSheet(rows, abs(ctx, paths.chain), cellSize(ctx.size));
}

export const assembleStage: Stage = {
  name: "assemble",
  perScene: false,
  paid: false,
  deps: (m) => [{ stage: "captions" }, ...m.scenes.map((s) => ({ stage: "fit" as const, scene: s.idx }))],
  async inputsFor(ctx) {
    const m = ctx.manifest;
    return {
      fitted: await shaAll(ctx, m.scenes.map((s) => requireFitted(s).path)),
      audio: await shaAll(ctx, m.scenes.map((s) => requireAudio(s).path)),
      clips: await shaAll(ctx, m.scenes.map((s) => requireClip(s).path)),
      captions: await fileSha256(abs(ctx, paths.captions)),
      bgm: m.request.bgm ? await fileSha256(m.request.bgm) : null,
    };
  },
  outputsFor: () => [paths.final, paths.chain],
  estimateCostUsd: () => 0,
  async run(ctx) {
    const m = ctx.manifest;
    const totalFrames = m.scenes.reduce((sum, s) => sum + requireFitted(s).frames, 0);
    const video = await outPath(ctx, paths.video);
    const narration = await outPath(ctx, paths.narration);
    await concatVideos(m.scenes.map((s) => abs(ctx, requireFitted(s).path)), video);
    await concatAudio(m.scenes.map((s) => abs(ctx, requireAudio(s).path)), narration);
    await finalize({
      video,
      narration,
      captions: abs(ctx, paths.captions),
      fontsDir: ctx.fontsDir,
      bgm: m.request.bgm,
      totalFrames,
      fps: ctx.fps,
      out: abs(ctx, paths.final),
    });
    await writeChainSheet(ctx);
    m.final = { path: paths.final, duration: totalFrames / ctx.fps, captions: paths.captions, chain: paths.chain };
    return 0;
  },
};
```

- [ ] **Step 6: Implement `src/stages/index.ts`**

```ts
import { assembleStage } from "./assemble.js";
import { captionsStage } from "./captions.js";
import { clipsStage } from "./clips.js";
import { fitStage } from "./fit.js";
import { keyframesStage } from "./keyframes.js";
import { scriptStage } from "./script.js";
import { silenceStage } from "./silence.js";
import type { Stage } from "./types.js";
import { ttsStage } from "./tts.js";

/** Pipeline order. Audio stages come before any visual stage: audio drives timing (spec §3). */
export const STAGES: Stage[] = [
  scriptStage,
  ttsStage,
  silenceStage,
  keyframesStage,
  clipsStage,
  fitStage,
  captionsStage,
  assembleStage,
];
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run test/stages/output-stages.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/stages/fit.ts src/stages/captions.ts src/stages/assemble.ts src/stages/index.ts test/stages/output-stages.test.ts
git commit -m "feat: add fit, captions and assemble stages and the stage registry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Reroll and end-to-end pipeline guarantees

**Files:**
- Create: `src/reroll.ts`
- Test: `test/unit/reroll.test.ts`, `test/pipeline/pipeline.test.ts`

**Interfaces:**
- Consumes: `needsKeyframe` (Task 13); `STAGES` (Task 14); `runPipeline`, `planRun` (Task 11); `loadManifest` (Task 2); `makeTestContext` (Task 12).
- Produces: `REROLLABLE = ["tts", "keyframes", "clips"]`, `bumpNonce(m, sceneNumber: number /* 1-based */, stage: string): void`.

- [ ] **Step 1: Write the failing unit test**

`test/unit/reroll.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { bumpNonce } from "../../src/reroll.js";
import { fakeScript } from "../fakes/providers.js";

function manifest() {
  const m = createManifest(
    "r",
    { topic: "t", aspect: "9:16", sceneCount: 3, modes: [1, 1, 1], voiceId: "v" },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );
  m.script = fakeScript(3, { shots: ["cut", "continue", "cut"] });
  return m;
}

describe("bumpNonce", () => {
  it("increments the nonce of a 1-based scene", () => {
    const m = manifest();
    bumpNonce(m, 2, "clips");
    bumpNonce(m, 2, "clips");
    expect(m.scenes[1].nonces.clips).toBe(2);
  });

  it("rejects unknown stages and out-of-range scenes", () => {
    expect(() => bumpNonce(manifest(), 1, "fit")).toThrow(/cannot reroll "fit"/);
    expect(() => bumpNonce(manifest(), 0, "tts")).toThrow(/between 1 and 3/);
    expect(() => bumpNonce(manifest(), 4, "tts")).toThrow(/between 1 and 3/);
  });

  it("refuses to reroll a keyframe the scene does not use", () => {
    expect(() => bumpNonce(manifest(), 2, "keyframes")).toThrow(/reroll its clips instead/);
    expect(() => bumpNonce(manifest(), 3, "keyframes")).not.toThrow();
  });
});
```

- [ ] **Step 2: Write the failing end-to-end test**

`test/pipeline/pipeline.test.ts`:
```ts
import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadManifest } from "../../src/manifest/store.js";
import { cellSize } from "../../src/media/contact-sheet.js";
import { countFrames, probeVideo, streamDuration } from "../../src/media/ffmpeg.js";
import { type Plan, planRun, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { STAGES } from "../../src/stages/index.js";
import { abs, paths } from "../../src/stages/paths.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("end-to-end with fakes", () => {
  it("renders a hybrid 1,2,1,1 video with a 4-row chain sheet", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 2, 1, 1], shots: ["cut", "continue", "continue", "cut"] });
    await runPipeline(ctx, STAGES, auto);
    const final = abs(ctx, paths.final);
    const total = ctx.manifest.scenes.reduce((a, s) => a + s.audio!.duration, 0);
    expect(await countFrames(final)).toBe(Math.round(total * 30));
    const drift = Math.abs((await streamDuration(final, "v")) - (await streamDuration(final, "a")));
    expect(drift).toBeLessThanOrEqual(1 / 30);
    const cell = cellSize(ctx.size);
    const sheet = await probeVideo(abs(ctx, paths.chain));
    expect(sheet.height).toBe(cell.height * 4);
  });

  it("resumes after a failed clip without repeating any completed paid call", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1, 1] });
    fakes.video.failWhen = (req) => basename(req.imagePath) === "last_02.png"; // scene 3's chain image
    await expect(runPipeline(ctx, STAGES, auto)).rejects.toThrow(/clip scene 3 failed after 3 attempts/);
    expect(fakes.video.calls).toHaveLength(5); // scenes 1, 2, then 3 attempts at scene 3

    const saved = await loadManifest(ctx.dir);
    expect(saved.scenes[2].stages.clips?.status).toBe("failed");

    fakes.video.failWhen = undefined;
    await runPipeline({ ...ctx, manifest: saved }, STAGES, auto);
    expect(fakes.llm.calls).toHaveLength(1);
    expect(fakes.tts.calls).toHaveLength(4);
    expect(fakes.image.calls).toHaveLength(1);
    expect(fakes.video.calls).toHaveLength(7); // + scenes 3 and 4
    expect((await loadManifest(ctx.dir)).final).toBeDefined();
  });

  it("a clip reroll cascades down the chain and stops at the next cut", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1, 1], shots: ["cut", "continue", "continue", "cut"] });
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.calls).toHaveLength(2);
    expect(fakes.video.calls).toHaveLength(4);

    bumpNonce(ctx.manifest, 2, "clips");
    const plan = await planRun(ctx, STAGES);
    expect(plan.items.filter((i) => i.costUsd > 0).map((i) => [i.stage, i.scene])).toEqual([
      ["clips", 1],
      ["clips", 2],
    ]);

    const confirm = vi.fn(async () => true);
    await runPipeline(ctx, STAGES, { budgetUsd: 100, confirm, reroll: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fakes.video.calls.slice(4).map((c) => basename(c.imagePath))).toEqual(["last_01.png", "last_02.png"]);
    expect(fakes.image.calls).toHaveLength(2);
    expect(fakes.tts.calls).toHaveLength(4);
  });

  it("the media checkpoint estimate equals what the ledger records", async () => {
    const plans: Array<[string, Plan]> = [];
    const { ctx } = await makeTestContext({ modes: [1, 2, 1] });
    await runPipeline(ctx, STAGES, { ...auto, onPlan: (p, label) => plans.push([label, p]) });
    const media = plans.find(([label]) => label === "Media plan")![1];
    const spent = ctx.manifest.ledger
      .filter((e) => e.stage === "keyframes" || e.stage === "clips")
      .reduce((a, e) => a + e.usd, 0);
    expect(spent).toBeCloseTo(media.totalUsd, 6);
    expect(media.totalUsd).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/reroll.test.ts test/pipeline/pipeline.test.ts`
Expected: FAIL — cannot resolve `../../src/reroll.js`.

- [ ] **Step 4: Implement `src/reroll.ts`**

```ts
import type { Manifest } from "./manifest/schema.js";
import { needsKeyframe } from "./stages/visual.js";

export const REROLLABLE = ["tts", "keyframes", "clips"] as const;
export type RerollStage = (typeof REROLLABLE)[number];

/**
 * Marks one scene-stage for regeneration by bumping its nonce. Downstream work (later chained clips,
 * fit, captions, assemble) re-runs automatically because its input hashes change.
 */
export function bumpNonce(m: Manifest, sceneNumber: number, stage: string): void {
  if (!(REROLLABLE as readonly string[]).includes(stage)) {
    throw new Error(`cannot reroll "${stage}" (use one of: ${REROLLABLE.join(", ")})`);
  }
  if (!Number.isInteger(sceneNumber) || sceneNumber < 1 || sceneNumber > m.scenes.length) {
    throw new Error(`--scene must be between 1 and ${m.scenes.length}`);
  }
  const idx = sceneNumber - 1;
  if (stage === "keyframes" && !needsKeyframe(m, idx)) {
    throw new Error(`scene ${sceneNumber} continues from the previous clip and has no keyframe; reroll its clips instead`);
  }
  const s = stage as RerollStage;
  const scene = m.scenes[idx];
  scene.nonces[s] = (scene.nonces[s] ?? 0) + 1;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/unit/reroll.test.ts test/pipeline/pipeline.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0. (The resume test waits for no backoff because `retryDelayMs` is 0.)

- [ ] **Step 6: Commit**

```bash
git add src/reroll.ts test/unit/reroll.test.ts test/pipeline/pipeline.test.ts
git commit -m "feat: add scene reroll and end-to-end resume/cascade/estimate tests" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: CLI, `doctor`, `status`, README

**Files:**
- Create: `src/status.ts`, `src/doctor.ts`, `src/cli.ts`, `README.md`
- Test: `test/unit/status.test.ts`, `test/media/doctor.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (status.ts): `formatStatus(m: Manifest): string`.
- Produces (doctor.ts): `Check`, `REQUIRED_FILTERS`, `parseFfmpegMajor(line)`, `checkFfmpeg()`, `runDoctor(env, fontsDir, models?)`, `formatChecks(checks)`.
- Produces (cli.ts): commands `doctor`, `run`, `resume <runId>`, `reroll <runId>`, `status <runId>`.

- [ ] **Step 1: Write the failing tests**

`test/unit/status.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { formatStatus } from "../../src/status.js";

describe("formatStatus", () => {
  it("summarizes stages, errors, spend and output", () => {
    const m = createManifest(
      "20261002-140509-abcdef",
      { topic: "foxes", aspect: "9:16", sceneCount: 2, modes: [1, 2], voiceId: "v" },
      { llm: "gemini-flash-latest", tts: "eleven_multilingual_v2", image: "fal-ai/flux/dev", video: "kling" },
    );
    const done = { status: "done" as const, inputHash: "h", costUsd: 0, finishedAt: "t" };
    m.runStages.script = done;
    m.scenes[0].stages.tts = done;
    m.scenes[0].stages.clips = { ...done, status: "failed", error: "boom" };
    m.ledger = [
      { stage: "script", usd: 0.01, at: "t" },
      { stage: "tts", scene: 0, usd: 0.25, at: "t" },
    ];
    const text = formatStatus(m);
    expect(text).toContain("Run 20261002-140509-abcdef — 9:16, 2 scenes, modes 1,2");
    expect(text).toContain("Run stages: script ✓  captions ·  assemble ·");
    expect(text).toContain("Scene 1 [mode 1]: tts ✓  silence ·  keyframes ·  clips ✗  fit ·");
    expect(text).toContain("  error in clips: boom");
    expect(text).toContain("Scene 2 [mode 2]: tts ·  silence ·  keyframes ·  clips ·  fit ·");
    expect(text).toContain("Spend (estimated from the price table, not invoices): $0.26 across 2 paid call(s)");
    expect(text).not.toContain("Final:");
  });
});
```

`test/media/doctor.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { checkFfmpeg, formatChecks, parseFfmpegMajor } from "../../src/doctor.js";

describe("doctor", () => {
  it("parses ffmpeg major versions", () => {
    expect(parseFfmpegMajor("ffmpeg version 8.1.2 Copyright (c) 2000-2026")).toBe(8);
    expect(parseFfmpegMajor("ffmpeg version n7.1 Copyright")).toBe(7);
    expect(parseFfmpegMajor("ffmpeg version N-118000-gabcdef Copyright")).toBeNull();
  });

  it("finds a usable ffmpeg on this machine", async () => {
    const checks = await checkFfmpeg();
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("formats checks one per line", () => {
    expect(formatChecks([{ name: "a", ok: true, detail: "fine" }, { name: "b", ok: false, detail: "bad" }])).toBe(
      "✓ a — fine\n✗ b — bad",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/status.test.ts test/media/doctor.test.ts`
Expected: FAIL — cannot resolve `../../src/status.js`.

- [ ] **Step 3: Implement `src/status.ts`**

```ts
import type { Manifest, StageName, StageRecord } from "./manifest/schema.js";
import { needsKeyframe } from "./stages/visual.js";

const mark = (r?: StageRecord) => (r === undefined ? "·" : r.status === "done" ? "✓" : "✗");
const RUN_STAGES: StageName[] = ["script", "captions", "assemble"];
const SCENE_STAGES: StageName[] = ["tts", "silence", "keyframes", "clips", "fit"];

export function formatStatus(m: Manifest): string {
  const { request: r, models } = m;
  const lines = [
    `Run ${m.runId} — ${r.aspect}, ${r.sceneCount} scenes, modes ${r.modes.join(",")}`,
    `Topic: ${r.topic}`,
    `Models: llm ${models.llm} · tts ${models.tts} · image ${models.image} · video ${models.video}`,
    `Run stages: ${RUN_STAGES.map((s) => `${s} ${mark(m.runStages[s])}`).join("  ")}`,
  ];
  for (const st of RUN_STAGES) {
    const rec = m.runStages[st];
    if (rec?.status === "failed") lines.push(`  error in ${st}: ${rec.error}`);
  }
  for (const scene of m.scenes) {
    const shown = SCENE_STAGES.filter((s) => s !== "keyframes" || needsKeyframe(m, scene.idx));
    lines.push(`Scene ${scene.idx + 1} [mode ${scene.mode}]: ${shown.map((s) => `${s} ${mark(scene.stages[s])}`).join("  ")}`);
    for (const st of SCENE_STAGES) {
      const rec = scene.stages[st];
      if (rec?.status === "failed") lines.push(`  error in ${st}: ${rec.error}`);
    }
  }
  const spend = m.ledger.reduce((sum, e) => sum + e.usd, 0);
  lines.push(
    `Spend (estimated from the price table, not invoices): $${spend.toFixed(2)} across ${m.ledger.length} paid call(s)`,
  );
  if (m.final) lines.push(`Final: ${m.final.path} (${m.final.duration.toFixed(2)} s) · chain sheet: ${m.final.chain}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Implement `src/doctor.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { Env } from "./config.js";
import type { Models } from "./manifest/schema.js";
import { ElevenLabsTts } from "./providers/elevenlabs.js";
import { checkFal, createFal } from "./providers/fal.js";
import { GeminiLlm } from "./providers/gemini.js";

export type Check = { name: string; ok: boolean; detail: string };

export const REQUIRED_FILTERS = [
  "silencedetect", "atrim", "concat", "zoompan", "ass", "tpad", "xstack", "sidechaincompress", "loudnorm",
];

export function parseFfmpegMajor(versionLine: string): number | null {
  const m = /ffmpeg version n?(\d+)\./.exec(versionLine);
  return m ? Number(m[1]) : null;
}

export async function checkFfmpeg(): Promise<Check[]> {
  const version = await execa("ffmpeg", ["-hide_banner", "-version"], { reject: false });
  if (version.exitCode !== 0) return [{ name: "ffmpeg", ok: false, detail: "not found on PATH (brew install ffmpeg)" }];
  const out = String(version.stdout);
  const firstLine = out.split("\n")[0];
  const major = parseFfmpegMajor(firstLine);
  const filters = String((await execa("ffmpeg", ["-hide_banner", "-filters"], { reject: false })).stdout);
  const missing = REQUIRED_FILTERS.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters));
  const probe = await execa("ffprobe", ["-version"], { reject: false });
  return [
    { name: "ffmpeg version", ok: major === null || major >= 6, detail: firstLine },
    { name: "libass", ok: out.includes("--enable-libass"), detail: "burns captions" },
    { name: "libx264", ok: out.includes("--enable-libx264"), detail: "encodes H.264" },
    { name: "filters", ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "all present" },
    { name: "ffprobe", ok: probe.exitCode === 0, detail: probe.exitCode === 0 ? "found" : "not found on PATH" },
  ];
}

async function attempt(name: string, fn: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** `models` lets resume/reroll check the models frozen in the manifest instead of today's env. */
export async function runDoctor(env: Env, fontsDir: string, models?: Models): Promise<Check[]> {
  const llmModel = models?.llm ?? env.GEMINI_MODEL;
  const ttsModel = models?.tts ?? env.ELEVENLABS_MODEL;
  const font = join(fontsDir, "Montserrat-ExtraBold.ttf");
  return [
    ...(await checkFfmpeg()),
    { name: "caption font", ok: existsSync(font), detail: font },
    await attempt(`Gemini model ${llmModel}`, async () => {
      await new GeminiLlm(env.GEMINI_API_KEY, llmModel).checkModel();
      return "available";
    }),
    await attempt("fal.ai key", async () => {
      await checkFal(createFal(env.FAL_KEY));
      return "storage upload works";
    }),
    await attempt(`ElevenLabs voice ${env.ELEVENLABS_VOICE_ID}`, async () => {
      await new ElevenLabsTts(env.ELEVENLABS_API_KEY, ttsModel).checkVoice(env.ELEVENLABS_VOICE_ID);
      return "available";
    }),
  ];
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`).join("\n");
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/unit/status.test.ts test/media/doctor.test.ts && npm run typecheck`
Expected: PASS, `tsc` exits 0.

- [ ] **Step 6: Implement `src/cli.ts`**

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { type Env, FPS, keyframeSize, loadEnv, loadPrices, outputSize } from "./config.js";
import { formatChecks, runDoctor } from "./doctor.js";
import { type Manifest, type Models, RunRequest, StageName } from "./manifest/schema.js";
import { createManifest, loadManifest, newRunId, resolveModes, saveManifest } from "./manifest/store.js";
import { type Plan, RunAborted, runPipeline } from "./pipeline.js";
import { ElevenLabsTts } from "./providers/elevenlabs.js";
import { createFal, FalImage, FalVideo } from "./providers/fal.js";
import { GeminiLlm } from "./providers/gemini.js";
import type { Providers } from "./providers/types.js";
import { bumpNonce, REROLLABLE } from "./reroll.js";
import { STAGES } from "./stages/index.js";
import type { StageContext } from "./stages/types.js";
import { formatStatus } from "./status.js";

const FONTS_DIR = resolve(import.meta.dirname, "../assets/fonts");

try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: rely on the real environment
}

function providersFor(env: Env, models: Models): Providers {
  const fal = createFal(env.FAL_KEY);
  return {
    llm: new GeminiLlm(env.GEMINI_API_KEY, models.llm),
    tts: new ElevenLabsTts(env.ELEVENLABS_API_KEY, models.tts),
    image: new FalImage(fal, models.image),
    video: new FalVideo(fal, models.video),
  };
}

async function askConfirm(_plan: Plan, reason: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(`Confirmation needed (${reason}) but stdin is not interactive; re-run with --yes.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`Proceed (${reason})? [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function requireDoctor(env: Env, models: Models): Promise<void> {
  const checks = await runDoctor(env, FONTS_DIR, models);
  if (checks.every((c) => c.ok)) return;
  console.error(formatChecks(checks));
  throw new Error("flowchain doctor failed: fix the items marked ✗ above");
}

function budget(raw: string | undefined, env: Env): number {
  if (raw === undefined) return env.FLOWCHAIN_BUDGET_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--budget must be a non-negative number, got "${raw}"`);
  return value;
}

const runsDir = () => process.env.RUNS_DIR ?? "./runs";
const runDir = (runId: string) => resolve(runsDir(), runId);

async function execute(
  env: Env,
  dir: string,
  manifest: Manifest,
  opts: { budgetUsd: number; yes?: boolean; reroll?: boolean; from?: StageName },
): Promise<void> {
  const ctx: StageContext = {
    dir,
    manifest,
    providers: providersFor(env, manifest.models),
    prices: loadPrices(),
    size: outputSize(manifest.request.aspect),
    keyframeSize: keyframeSize(manifest.request.aspect),
    fps: FPS,
    fontsDir: FONTS_DIR,
    retryDelayMs: 2000,
    log: (message) => console.log(message),
  };
  try {
    await runPipeline(ctx, STAGES, { ...opts, confirm: askConfirm });
  } catch (err) {
    if (err instanceof RunAborted) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    console.error(`\nResume with: npm run flowchain -- resume ${manifest.runId}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${formatStatus(manifest)}`);
  if (manifest.final) {
    console.log(`\nVideo:       ${resolve(dir, manifest.final.path)}`);
    console.log(`Chain sheet: ${resolve(dir, manifest.final.chain)}`);
  }
}

type RunFlags = {
  topic: string;
  aspect: string;
  scenes: string;
  mode: string;
  modes?: string;
  voice?: string;
  bgm?: string;
  budget?: string;
  yes?: boolean;
};

const program = new Command()
  .name("flowchain")
  .description("Flow-Chain-AI Phase 1: topic → captioned short video with a continuity chain");

program
  .command("doctor")
  .description("check ffmpeg, fonts, API keys and model availability")
  .action(async () => {
    const env = loadEnv();
    const checks = await runDoctor(env, FONTS_DIR);
    console.log(formatChecks(checks));
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  });

program
  .command("run")
  .description("start a new run")
  .requiredOption("--topic <text>", "what the video is about")
  .addOption(new Option("--aspect <ratio>", "output aspect ratio").choices(["9:16", "16:9"]).default("9:16"))
  .option("--scenes <n>", "number of scenes (1-12)", "4")
  .addOption(new Option("--mode <mode>", "mode for every scene (auto = 1)").choices(["auto", "1", "2"]).default("auto"))
  .option("--modes <list>", "per-scene modes, e.g. 1,2,1,1 (overrides --mode)")
  .option("--voice <id>", "ElevenLabs voice id (default: ELEVENLABS_VOICE_ID)")
  .option("--bgm <file>", "background music, ducked under the narration")
  .option("--budget <usd>", "ask before spending more than this (default: FLOWCHAIN_BUDGET_USD)")
  .option("--yes", "never ask for confirmation")
  .action(async (o: RunFlags) => {
    const env = loadEnv();
    const sceneCount = Number(o.scenes);
    const modes = resolveModes(o.mode, o.modes, sceneCount);
    if (o.bgm && !existsSync(o.bgm)) throw new Error(`--bgm file not found: ${o.bgm}`);
    const request = RunRequest.parse({
      topic: o.topic,
      aspect: o.aspect,
      sceneCount,
      modes,
      voiceId: o.voice ?? env.ELEVENLABS_VOICE_ID,
      bgm: o.bgm ? resolve(o.bgm) : undefined,
    });
    const models: Models = {
      llm: env.GEMINI_MODEL,
      tts: env.ELEVENLABS_MODEL,
      image: env.FAL_IMAGE_MODEL,
      video: env.FAL_VIDEO_MODEL,
    };
    await requireDoctor(env, models);
    const runId = newRunId();
    const dir = runDir(runId);
    const manifest = createManifest(runId, request, models);
    await saveManifest(dir, manifest);
    console.log(`Run ${runId} → ${dir}`);
    await execute(env, dir, manifest, { budgetUsd: budget(o.budget, env), yes: o.yes });
  });

program
  .command("resume <runId>")
  .description("continue a run after a failure or interruption")
  .addOption(new Option("--from <stage>", "re-run this stage and every later one").choices(StageName.options))
  .option("--budget <usd>", "ask before spending more than this")
  .option("--yes", "never ask for confirmation")
  .action(async (runId: string, o: { from?: StageName; budget?: string; yes?: boolean }) => {
    const env = loadEnv();
    const dir = runDir(runId);
    const manifest = await loadManifest(dir);
    await requireDoctor(env, manifest.models);
    await execute(env, dir, manifest, { budgetUsd: budget(o.budget, env), yes: o.yes, from: o.from });
  });

program
  .command("reroll <runId>")
  .description("regenerate one scene's voiceover, keyframe or clip; later chained clips follow automatically")
  .requiredOption("--scene <n>", "scene number, starting at 1")
  .addOption(new Option("--stage <stage>", "what to regenerate").choices([...REROLLABLE]).makeOptionMandatory())
  .option("--yes", "never ask for confirmation")
  .action(async (runId: string, o: { scene: string; stage: string; yes?: boolean }) => {
    const env = loadEnv();
    const dir = runDir(runId);
    const manifest = await loadManifest(dir);
    bumpNonce(manifest, Number(o.scene), o.stage);
    await requireDoctor(env, manifest.models);
    await execute(env, dir, manifest, { budgetUsd: budget(undefined, env), yes: o.yes, reroll: true });
  });

program
  .command("status <runId>")
  .description("show a run's progress, errors and spend")
  .action(async (runId: string) => {
    console.log(formatStatus(await loadManifest(runDir(runId))));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
```

- [ ] **Step 7: Verify the CLI surface**

Run:
```bash
npm run typecheck
npm run flowchain -- --help
npm run flowchain -- run --help
env -u GEMINI_API_KEY -u FAL_KEY -u ELEVENLABS_API_KEY -u ELEVENLABS_VOICE_ID npm run flowchain -- doctor; echo "exit=$?"
```
Expected: `tsc` exits 0; help lists `doctor`, `run`, `resume`, `reroll`, `status`; `run --help` shows `--aspect` choices `9:16, 16:9` and `--modes`; the last command (if no `.env` exists yet) prints `Invalid environment (copy .env.example to .env …)` naming the four keys and `exit=1`.

- [ ] **Step 8: Write `README.md`**

````markdown
# Flow-Chain-AI — Phase 1 CLI

Turns a topic into a captioned short video. Audio drives timing: the voiceover is generated and
silence-trimmed first, then every visual is fitted to it frame-exactly.

Design: `docs/superpowers/specs/2026-10-02-phase1-cli-poc-design.md`

## Setup

1. `brew install ffmpeg` (≥ 6 with libass and libx264), Node ≥ 22.12
2. `npm install`
3. `cp .env.example .env` and fill in `GEMINI_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
4. `npm run flowchain -- doctor` — every line must show ✓

## Usage

```bash
npm run flowchain -- run --topic "The last lighthouse keeper" --scenes 4            # all Mode 1 (AI video chain)
npm run flowchain -- run --topic "…" --modes 1,2,1,1 --aspect 16:9 --bgm music.mp3 # hybrid
npm run flowchain -- status <runId>
npm run flowchain -- resume <runId> [--from clips]
npm run flowchain -- reroll <runId> --scene 2 --stage clips    # later chained clips follow
```

Mode 1 = Kling image-to-video, each clip continuing from the previous clip's last frame.
Mode 2 = Flux still + Ken Burns camera move (no video API cost).

Each run lives in `runs/<runId>/`: `manifest.json` (state, cache keys, cost ledger), `final.mp4`,
`chain.png` (first/last frame of every clip — use it to judge continuity drift), plus intermediates.

## Costs

Estimates come from the price table in `src/config.ts` (override with `prices.json`). A run asks for
confirmation when the estimate exceeds `FLOWCHAIN_BUDGET_USD` (default $3); rerolls always ask; `--yes`
skips. A typical 4-scene Mode 1 run is about $1.20. `npm run smoke` runs a real 3-scene all-Mode-1 video
(≈ $0.90–1.80, depending on 5/10 s clip buckets and how many scenes are cuts).

## Tests

`npm test` runs unit, ffmpeg and fake-provider pipeline tests offline. `npm run typecheck` runs `tsc`.
````

- [ ] **Step 9: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: every test file PASSES; `tsc` exits 0.

- [ ] **Step 10: Commit**

```bash
git add src/status.ts src/doctor.ts src/cli.ts README.md test/unit/status.test.ts test/media/doctor.test.ts
git commit -m "feat: add flowchain CLI with doctor, run, resume, reroll and status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Live smoke test (manual, real APIs, ≈ $0.90–1.80)

Requires the user's real keys in `.env`. Do not run in CI. Ask the user before spending money.

- [ ] **Step 1:** `npm run flowchain -- doctor` → every line ✓. If the Gemini line fails with a model error, set `GEMINI_MODEL` to a currently listed Flash model and re-run.
- [ ] **Step 2:** `npm run smoke` → 3-scene all-Mode-1 (`1,1,1`) run, so the continuity chain is exercised. Confirm the printed media-plan estimate is ≈ $0.90–1.80 depending on the 5/10 s buckets and the cuts the LLM chose: 1–3 Flux keyframes (≈ $0.05 each; one per `cut` scene plus scene 1), three Kling clips ($0.25 per 5 s clip, $0.50 per 10 s clip) and ≈ $0.12 TTS.
- [ ] **Step 3:** Open `runs/<runId>/final.mp4`: captions track the voice word by word; no audible gaps > 200 ms; no black frames or freezes at scene boundaries.
- [ ] **Step 4:** Open `runs/<runId>/script.json` and check that at least one scene after scene 1 has `"shot": "continue"`. If the LLM chose `cut` for every scene, no seam was tested: start a new `npm run smoke` run (another ≈ $1) until one has a `continue` scene. Then judge every continue seam in `final.mp4` (the cut into the continuing scene should look like the same shot carrying on, with no jump back or forward in motion) and in `chain.png`, whose columns are the first frame of the raw clip and the last frame of the fitted clip: for a continuing scene N, row N−1's right cell (what viewers last saw) and row N's left cell should be near-identical. Note the drift you see for the Phase 2 decision.
- [ ] **Step 5:** `npm run flowchain -- reroll <runId> --scene 3 --stage clips` → confirm prompt shows only scene 3's clip as paid work; after it finishes, `status` shows the ledger grew by one clip.
- [ ] **Step 6:** Record findings (cost actuals vs. ledger, drift, timing) in `docs/superpowers/specs/2026-10-02-phase1-cli-poc-design.md` under a new "## 13. Smoke Test Findings" section and commit:

```bash
git add docs/superpowers/specs/2026-10-02-phase1-cli-poc-design.md
git commit -m "docs: record Phase 1 smoke test findings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
