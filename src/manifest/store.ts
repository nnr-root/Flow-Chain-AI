import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { DEFAULT_SCENE_SECONDS, expectedScenes, parseDuration, parseSceneSeconds, type Timing } from "../duration.js";
import { Manifest, MAX_COUNTED_SCENES, type Mode, type Models, RunRequest, SCHEMA_VERSION, type Shot } from "./schema.js";

export const MANIFEST_FILE = "manifest.json";
export const LOCK_FILE = ".lock";

/**
 * Runs `fn` while holding `<runDir>/.lock` (created exclusively with flag "wx"), so two flowchain processes
 * can never execute the same run at once (and buy the same work twice). The lock is removed in finally,
 * and on SIGINT/SIGTERM (Ctrl-C) before the process is terminated by that signal as usual. Only a hard kill
 * (SIGKILL, power loss) leaves it behind; then it must be deleted by hand.
 */
export async function withRunLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const path = join(dir, LOCK_FILE);
  await mkdir(dir, { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new Error(
      `run is already in progress: ${path} exists. If no other flowchain process is working on this run ` +
        "(e.g. after a crash), delete that file and try again.",
    );
  }
  // Removes the lock synchronously, then re-raises the signal so the process still ends the default way.
  const onSignal = (signal: NodeJS.Signals) => {
    rmSync(path, { force: true });
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.kill(process.pid, signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return await fn();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await rm(path, { force: true });
  }
}

export function newRunId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Validates the request (filling defaults such as `render`) and lays out one state per scene. */
export function createManifest(
  runId: string,
  input: z.input<typeof RunRequest>,
  models: Models,
  now: Date = new Date(),
): Manifest {
  const request = RunRequest.parse(input);
  if (request.modes && request.modes.length !== request.sceneCount) {
    throw new Error(`modes has ${request.modes.length} entries but sceneCount is ${request.sceneCount}`);
  }
  if (!request.modes && (request.modeBudgetUsd === undefined || request.modePrices === undefined)) {
    throw new Error("auto modes need modeBudgetUsd and modePrices");
  }
  if (request.modeOverrides) assertModeOverrides(request);
  // Auto runs start as all Mode 1 (the most expensive assumption) until the modes stage has run. A scene that
  // was pinned starts as what it was pinned to: a run made of pictures only is not priced, before its script
  // exists, as if every scene were a clip (which put a two-minute one over a cap it was nowhere near).
  const modes = request.modes ?? Array.from({ length: request.sceneCount }, (_, i): Mode => request.modeOverrides?.[i] ?? 1);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    createdAt: now.toISOString(),
    request,
    models,
    runStages: {},
    scenes: modes.map((mode, idx) => ({ idx, mode, nonces: {}, stages: {}, jobs: {} })),
    ledger: [],
  };
}

/**
 * Gives a run asked for by its length the number of scenes its script turned out to have (phase 7 spec §3).
 * Until the script is written such a run is laid out for an assumed number.
 *
 * A scene that is still there keeps its state (a script written again changes what its stages read, and they
 * run again by their hashes, as for any run). A scene that is no longer there may have had a provider job on
 * its way: the provider bills it all the same, so what it was expected to cost, and what the scene had already
 * given up, moves to the run's own `abandonedUsd` before the scene is dropped. No paid call leaves the record.
 */
export function layOutScenes(m: Manifest, count: number): void {
  const r = m.request;
  if (!r.timing) throw new Error("only a run asked for by its length has its scenes laid out again");
  // one choice for every scene is all such a run can have been given (the CLI refuses a list with --duration)
  const uniform = <T>(list: T[] | undefined, what: string): T[] | undefined => {
    if (!list) return undefined;
    if (list.some((v) => v !== list[0])) throw new Error(`a run asked for by its length cannot have ${what} per scene`);
    return Array.from({ length: count }, () => list[0]);
  };
  if (r.shots) throw new Error("a run asked for by its length cannot have shots per scene");
  r.modes = uniform(r.modes, "modes");
  r.modeOverrides = uniform(r.modeOverrides, "pinned modes");
  if (r.modes === undefined) delete r.modes;
  if (r.modeOverrides === undefined) delete r.modeOverrides;
  r.sceneCount = count;
  let lost = 0;
  for (const gone of m.scenes.slice(count)) {
    lost += gone.abandonedUsd ?? 0;
    for (const job of Object.values(gone.jobs)) {
      if (job && !job.result && !(job.chargedUsd > 0) && job.expectedUsd !== undefined && job.expectedUsd > 0) lost += job.expectedUsd;
    }
  }
  if (lost > 0) m.abandonedUsd = Math.round(((m.abandonedUsd ?? 0) + lost) * 10_000) / 10_000;
  const mode = (): Mode => r.modes?.[0] ?? r.modeOverrides?.[0] ?? 1;
  m.scenes = Array.from({ length: count }, (_, idx) => m.scenes[idx] ?? { idx, mode: mode(), nonces: {}, stages: {}, jobs: {} });
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
  const raw = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8")) as { runId?: string; schemaVersion?: number };
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `run ${raw.runId ?? dir} was created by an older flowchain (schema ${raw.schemaVersion ?? "unknown"}); ` +
        "start a new run",
    );
  }
  return Manifest.parse(raw);
}

/**
 * How many scenes a new run is laid out for, and its timing when it is asked for by its length. By its length
 * the script decides the number of scenes, so nothing can be given per scene: a list of modes or shots has no
 * scenes to belong to yet.
 */
export function resolveShape(o: { scenes?: string; duration?: string; sceneSeconds?: string; modes?: string; shots?: string; pinModes?: string }): { sceneCount: number; timing?: Timing } {
  if (o.duration === undefined) {
    if (o.sceneSeconds !== undefined) throw new Error("--scene-seconds goes with --duration");
    const sceneCount = Number(o.scenes ?? 4);
    if (!Number.isInteger(sceneCount) || sceneCount < 1 || sceneCount > MAX_COUNTED_SCENES) throw new Error(`--scenes must be a whole number from 1 to ${MAX_COUNTED_SCENES}; got "${o.scenes}"`);
    return { sceneCount };
  }
  if (o.scenes !== undefined) throw new Error("give --duration or --scenes, not both: with a length, the script decides the number of scenes");
  const lists = [["--modes", o.modes], ["--shots", o.shots], ["--pin-modes", o.pinModes?.includes(",") ? o.pinModes : undefined]].filter(([, v]) => v !== undefined);
  if (lists.length > 0) throw new Error(`${lists[0][0]} lists a value per scene, and with --duration the number of scenes is the script's to decide`);
  const timing = { targetSec: parseDuration(o.duration), sceneSec: parseSceneSeconds(o.sceneSeconds ?? `${DEFAULT_SCENE_SECONDS.min}-${DEFAULT_SCENE_SECONDS.max}`) };
  return { sceneCount: expectedScenes(timing), timing };
}

/** Explicit per-scene modes from --modes or --mode 1|2; undefined for --mode auto (the modes stage decides). */
export function resolveModes(mode: string, modes: string | undefined, sceneCount: number): Mode[] | undefined {
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
  if (mode === "auto") return undefined;
  if (mode === "1") return Array.from({ length: sceneCount }, (): Mode => 1);
  if (mode === "2") return Array.from({ length: sceneCount }, (): Mode => 2);
  throw new Error(`invalid --mode "${mode}" (use auto, 1 or 2)`);
}

/** Parses --shots (a testing override, one continue|cut per scene); undefined lets the LLM decide. */
export function resolveShots(shots: string | undefined, sceneCount: number): Shot[] | undefined {
  if (shots === undefined) return undefined;
  const parsed = shots.split(",").map((raw): Shot => {
    const s = raw.trim();
    if (s !== "continue" && s !== "cut") throw new Error(`invalid shot "${s}" in --shots (use continue or cut)`);
    return s;
  });
  if (parsed.length !== sceneCount) throw new Error(`--shots has ${parsed.length} entries but --scenes is ${sceneCount}`);
  if (parsed[0] !== "cut") throw new Error('--shots: scene 1 must be "cut" (there is no earlier clip to continue from)');
  return parsed;
}

/** Overrides pin scenes of an auto run, one entry per scene. */
export function assertModeOverrides(request: RunRequest): void {
  if (request.modes) throw new Error("mode overrides need an auto run; this run has explicit modes");
  if (request.modeOverrides && request.modeOverrides.length !== request.sceneCount) {
    throw new Error(`modeOverrides has ${request.modeOverrides.length} entries but sceneCount is ${request.sceneCount}`);
  }
}
