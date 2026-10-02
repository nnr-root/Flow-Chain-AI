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
