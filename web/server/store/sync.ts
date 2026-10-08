import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RUN_ID } from "@src/studio/commands";
import { UUID } from "../tenant";
import type { ObjectStore } from "./s3";

/* Keeping a folder on disk and its lasting copy in the bucket in step: store what changed, restore what is missing. */

/** Where a user's things live in the bucket. The user id comes from a verified session or a checked job, never from a request. */
export const keys = {
  run: (userId: string, runId: string) => `users/${userId}/runs/${runId}/`,
  brandKits: (userId: string) => `users/${userId}/brand-kits/`,
  music: (userId: string) => `users/${userId}/music/`,
};

/** What was last stored of a folder, kept inside it. */
export const INDEX = ".stored.json";
/** Never stored: the render's working files, the pipeline's lock, the index itself, half-written files. */
const SKIP = [/^render\//, /^\.lock$/, /^\.stored\.json$/, /\.part$/, /\.tmp$/];

type Index = Record<string, { size: number; mtimeMs: number }>;

async function filesIn(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesIn(path, base)));
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join("/"));
  }
  return out;
}

async function readIndex(dir: string): Promise<Index> {
  try {
    return JSON.parse(await readFile(join(dir, INDEX), "utf8")) as Index;
  } catch {
    return {};
  }
}

/** Uploads the files of `dir` that are new or changed since the last store. Returns how many were sent. */
export async function storeFolder(store: ObjectStore, dir: string, prefix: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const index = await readIndex(dir);
  let sent = 0;
  for (const name of (await filesIn(dir)).sort(markersLast)) {
    if (SKIP.some((re) => re.test(name))) continue;
    const info = await stat(join(dir, name));
    const known = index[name];
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) continue;
    await store.putFile(prefix + name, join(dir, name));
    index[name] = { size: info.size, mtimeMs: info.mtimeMs };
    sent++;
    // recorded file by file: a store that is cut off starts again where it stopped
    await writeFile(join(dir, INDEX), JSON.stringify(index));
  }
  return sent;
}

/**
 * The file that says "this folder is whole" — a run's manifest, a kit's description. Sent last and fetched last,
 * removed first: neither the bucket's copy nor this disk's ever has it before it has everything it speaks of.
 */
const MARKERS = new Set(["manifest.json", "brand.json"]);
const MARKER = "manifest.json";
const markersLast = (a: string, b: string): number => Number(MARKERS.has(a)) - Number(MARKERS.has(b)) || (a < b ? -1 : a > b ? 1 : 0);
/** Restores in flight in this process, by folder: a second asker waits for the first instead of racing it. */
const restoring = new Map<string, Promise<number>>();

/**
 * Downloads what the bucket has under `prefix` and `dir` lacks. Returns how many files were fetched.
 *
 * A file that exists here is never replaced: what is on this disk is at least as new as what was stored, and a
 * manifest overwritten with an older one would forget what the run has bought.
 *
 * The manifest comes last. The pipeline takes a finished stage whose output file is missing for one that must
 * be done — and paid for — again, so a run folder must never have its manifest before it has everything else:
 * a restore that is cut off leaves a folder without a manifest, which nothing will start a job on.
 */
export function restoreFolder(store: ObjectStore, prefix: string, dir: string): Promise<number> {
  const running = restoring.get(dir);
  if (running) return running;
  const work = restoreNow(store, prefix, dir).finally(() => restoring.delete(dir));
  restoring.set(dir, work);
  return work;
}

async function restoreNow(store: ObjectStore, prefix: string, dir: string): Promise<number> {
  const index = await readIndex(dir);
  let fetched = 0;
  const objects = (await store.list(prefix))
    .map((object) => ({ ...object, name: object.key.slice(prefix.length) }))
    // what a bucket holds is not trusted to stay inside the folder
    .filter(({ name }) => name && !name.split("/").some((part) => part === "" || part === "." || part === "..") && !name.includes("\\"))
    .sort((a, b) => markersLast(a.name, b.name));
  for (const object of objects) {
    const path = join(dir, object.name);
    if (existsSync(path)) continue;
    await store.getToFile(object.key, path);
    const info = await stat(path);
    index[object.name] = { size: info.size, mtimeMs: info.mtimeMs };
    fetched++;
  }
  if (fetched > 0) await writeFile(join(dir, INDEX), JSON.stringify(index));
  return fetched;
}

/** Whether a restore of this folder is under way in this process. */
export const isRestoring = (dir: string): boolean => restoring.has(dir);

/** Whether everything in `dir` is in the bucket as it is now. */
export async function isStored(dir: string): Promise<boolean> {
  const index = await readIndex(dir);
  for (const name of await filesIn(dir)) {
    if (SKIP.some((re) => re.test(name))) continue;
    const info = await stat(join(dir, name));
    const known = index[name];
    if (!known || known.size !== info.size || known.mtimeMs !== info.mtimeMs) return false;
  }
  return true;
}

/**
 * Frees disk: removes run folders that are wholly in the bucket and untouched for `days`. They come back when
 * their owner opens them. Returns the run ids removed.
 */
export async function cleanCache(runsRoot: string, days: number, now = Date.now(), busy: (runId: string) => boolean = () => false): Promise<string[]> {
  if (!existsSync(runsRoot)) return [];
  const removed: string[] = [];
  for (const user of await readdir(runsRoot)) {
    if (!UUID.test(user)) continue;
    for (const runId of await readdir(join(runsRoot, user))) {
      const dir = join(runsRoot, user, runId);
      if (!RUN_ID.test(runId) || existsSync(join(dir, ".lock")) || busy(runId) || restoring.has(dir)) continue;
      const names = await filesIn(dir).catch(() => [] as string[]);
      const newest = Math.max(0, ...(await Promise.all(names.map((n) => stat(join(dir, n)).then((s) => s.mtimeMs, () => now)))));
      if (now - newest < days * 86_400_000 || !(await isStored(dir))) continue;
      // the manifest goes first: a removal that is cut off must not leave a folder that looks like a whole run
      await rm(join(dir, MARKER), { force: true });
      await rm(dir, { recursive: true, force: true });
      removed.push(runId);
    }
  }
  return removed;
}
