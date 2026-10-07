import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { Prices } from "@src/config";
import type { Manifest } from "@src/manifest/schema";
import { createManifest, saveManifest } from "@src/manifest/store";
import { fakeScript } from "../../test/fakes/providers";

export const STUB_CLI = resolve("web/test/stub-cli.mjs");
const KEYS = [
  "FLOWCHAIN_ROOT", "RUNS_DIR", "FLOWCHAIN_CLI", "BRAND_KITS_DIR", "STUDIO_UPLOADS_DIR", "STUDIO_MAX_JOBS",
  "REDIS_URL", "STUDIO_HOST", "WORKER_CONCURRENCY", "WORKER_DRAIN_MS",
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "STUDIO_USER_JOBS", "STUDIO_CACHE_DAYS",
  "STUDIO_BUCKET", "STUDIO_S3_ENDPOINT", "STUDIO_R2_ACCOUNT_ID", "STUDIO_R2_ACCESS_KEY_ID", "STUDIO_R2_SECRET_ACCESS_KEY",
  "GEMINI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "FAL_KEY", "PROVIDER_MODE", "FLOWCHAIN_BUDGET_USD",
  "RUNPOD_API_KEY", "RUNPOD_KEYFRAME_ENDPOINT", "RUNPOD_CLIP_ENDPOINT", "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
];

export type Studio = { root: string; runs: string };

/** Each test gets its own empty "repository" with the stub CLI; the real environment is put back afterwards. */
export function useStudio(): Studio {
  const studio = { root: "", runs: "" };
  let saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    studio.root = await mkdtemp(join(tmpdir(), "fc-studio-"));
    studio.runs = join(studio.root, "runs");
    await mkdir(studio.runs, { recursive: true });
    Object.assign(process.env, { FLOWCHAIN_ROOT: studio.root, RUNS_DIR: studio.runs, FLOWCHAIN_CLI: STUB_CLI });
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  return studio;
}

/** The keys a fal run needs, so the new-video form's check passes. */
export function withFalKeys(): void {
  Object.assign(process.env, { GEMINI_API_KEY: "g", ELEVENLABS_API_KEY: "e", ELEVENLABS_VOICE_ID: "v", FAL_KEY: "f" });
}

const done = { status: "done" as const, inputHash: "h", costUsd: 0, finishedAt: "t" };
let counter = 0;
/** A fresh, valid run id per call. */
export const nextRunId = (): string => `20261006-1200${String(counter++ % 60).padStart(2, "0")}-${(0xabc000 + counter).toString(16)}`;

/** An auto run with a script and nothing else: a draft (scene 2 continues scene 1; scene 3 is a low-action cut). */
export function draftManifest(runId: string): Manifest {
  const m = createManifest(
    runId,
    { topic: "foxes at night", aspect: "9:16", sceneCount: 3, modeBudgetUsd: 10, modePrices: Prices.parse({}), voiceId: "v" },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );
  m.script = fakeScript(3, { shots: ["cut", "continue", "cut"], actionLevels: ["high", "medium", "low"] });
  m.runStages.script = done;
  m.ledger.push({ stage: "script", usd: 0.0055, at: "t" });
  return m;
}

/** The same run finished: audio everywhere, fitted clips for scenes 1 and 2, a still for scene 3, a final video. */
export function finishedManifest(runId: string): Manifest {
  const m = draftManifest(runId);
  m.scenes[2].mode = 2;
  m.scenes.forEach((s, i) => {
    s.stages.tts = done;
    s.stages.silence = done;
    s.audio = {
      path: `audio/scene_0${i + 1}.wav`,
      duration: [1.5, 1.0, 2.0][i],
      removedSec: 0,
      words: [
        { text: "alpha", start: 0.1, end: 0.4 },
        { text: "beta", start: 0.4, end: 0.8 },
      ],
    };
  });
  m.scenes[0].fitted = { path: "fitted/scene_01.mp4", frames: 45, plan: { kind: "trim" } };
  m.scenes[1].fitted = { path: "fitted/scene_02.mp4", frames: 30, plan: { kind: "trim" } };
  m.runStages.render = done;
  m.final = { path: "final.mp4", duration: 4.5, chain: "chain.png" };
  m.ledger.push({ stage: "tts", scene: 0, usd: 0.02, at: "t" });
  return m;
}

export async function saveRun(studio: Studio, m: Manifest): Promise<string> {
  const dir = join(studio.runs, m.runId);
  await saveManifest(dir, m);
  return dir;
}

/** Every CLI call the stub received, in order. */
export async function calls(studio: Studio): Promise<string[][]> {
  const text = await readFile(join(studio.runs, "_calls.jsonl"), "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

export const stub = (studio: Studio, file: string, value: unknown): Promise<void> =>
  writeFile(join(studio.runs, file), JSON.stringify(value));

/** Waits until `check` returns something truthy (jobs end in another process). */
export async function until<T>(check: () => T | Promise<T>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A request as the studio's own pages send it. */
export function request(path: string, init: { method?: string; json?: unknown; headers?: Record<string, string>; body?: BodyInit } = {}): Request {
  const method = init.method ?? (init.json !== undefined || init.body !== undefined ? "POST" : "GET");
  return new Request(`http://127.0.0.1:3131${path}`, {
    method,
    headers: {
      host: "127.0.0.1:3131",
      ...(method === "GET" ? {} : { "sec-fetch-site": "same-origin" }),
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
}

export const params = <T extends Record<string, unknown>>(value: T): { params: Promise<T> } => ({ params: Promise.resolve(value) });
