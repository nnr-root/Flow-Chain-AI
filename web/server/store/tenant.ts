import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { roots } from "../config";
import { ApiError } from "../http";
import { currentUser, userDb } from "../tenant";
import { objectStore } from "./s3";
import { keys, restoreFolder, storeFolder } from "./sync";

/* What the web does with the bucket for the signed-in user: keep uploads there, and fetch back what a new or cleaned disk lacks. */

/** The bucket and the user it is used for, or null when there are no accounts or no bucket. */
function mine() {
  const user = currentUser();
  if (!user) return null;
  let store;
  try {
    store = objectStore();
  } catch (err) {
    throw unavailable(err); // half a configuration: the same answer as a bucket that is away
  }
  return store ? { user, store } : null;
}

/** What went wrong stays in the server's log; the visitor learns only that storage could not be reached. */
function unavailable(err: unknown): ApiError {
  console.error("storage:", err instanceof Error ? err.message : String(err));
  return new ApiError("storage_unavailable", "the studio's storage could not be reached", "nothing was saved; try again in a moment");
}

/** What the database says when an account has as many kits or tracks as one may have. */
const FULL: Record<string, string> = {
  too_many_brand_kits: "you have as many brand kits as one account may have; remove one first",
  too_many_tracks: "you have as many tracks as one account may have; remove one first",
};
const refused = (message: string): ApiError | null => (FULL[message] ? new ApiError("validation", FULL[message]) : null);

/**
 * With accounts, before an upload is accepted: is there room for one more? The registration afterwards is what
 * enforces the limit; this asks first so that a file is not written, and sent to the bucket, only to be refused.
 */
export async function assertRoomFor(what: "brand_kits" | "music_tracks"): Promise<void> {
  if (!currentUser()) return;
  const { data, error } = await userDb().rpc("library_room", { p_what: what });
  if (error) throw new Error(`asking for room: ${error.message}`);
  if (data !== true) throw refused(what === "brand_kits" ? "too_many_brand_kits" : "too_many_tracks")!;
}

/**
 * Makes an uploaded brand kit the user's: with a bucket its files go there, and with or without one the kit is
 * registered — which is what counts it against the account's limit. If any of it fails the kit is removed
 * again, so nothing exists that is not on record.
 */
export async function keepBrandKit(slug: string, name: string): Promise<void> {
  const user = currentUser();
  if (!user) return;
  const m = mine();
  const dir = join(roots().brandKits, slug);
  const prefix = `${keys.brandKits(user.id)}${slug}/`;
  try {
    if (m) await storeFolder(m.store, dir, prefix);
    const { error } = await userDb().rpc("register_brand_kit", { p_slug: slug, p_name: name });
    if (error) throw refused(error.message) ?? new Error(error.message);
  } catch (err) {
    // nothing of a kit that was not saved may stay behind, here or in the bucket (it would come back with the next restore)
    await rm(dir, { recursive: true, force: true });
    if (m) await m.store.list(prefix).then((objects) => Promise.all(objects.map((o) => m.store.remove(o.key)))).catch(() => {});
    throw err instanceof ApiError ? err : unavailable(err);
  }
}

export async function keepTrack(file: string, name: string, bytes: number): Promise<void> {
  const user = currentUser();
  if (!user) return;
  const m = mine();
  const path = join(roots().uploads, file);
  try {
    if (m) await m.store.putFile(`${keys.music(user.id)}${file}`, path);
    const { error } = await userDb().rpc("register_track", { p_id: file.replace(/\.mp3$/, "").toLowerCase(), p_name: name, p_bytes: bytes });
    if (error) throw refused(error.message) ?? new Error(error.message);
  } catch (err) {
    await rm(path, { force: true });
    if (m) await m.store.remove(`${keys.music(user.id)}${file}`).catch(() => {});
    throw err instanceof ApiError ? err : unavailable(err);
  }
}

/** Kits and tracks the database lists and the bucket did not have, by "user/name": not asked for again for a while. */
const missed = new Map<string, number>();
const MISS_MS = 60_000;

/**
 * Brings onto this disk the kits and tracks the database lists and the disk lacks (a new server, a disk that
 * was cleaned): those and no others, so nothing the database does not know of can appear. Costs two small
 * queries when nothing is missing.
 */
export async function bringLibrary(): Promise<void> {
  const m = mine();
  if (!m) return;
  const r = roots();
  const [kits, tracks] = await Promise.all([userDb().from("brand_kits").select("slug"), userDb().from("music_tracks").select("id")]);
  if (kits.error || tracks.error) throw new Error(`reading the library: ${(kits.error ?? tracks.error)!.message}`);
  const due = (name: string) => (missed.get(`${m.user.id}/${name}`) ?? 0) < Date.now() - MISS_MS;
  const miss = (name: string) => missed.set(`${m.user.id}/${name}`, Date.now());
  try {
    for (const { slug } of kits.data as Array<{ slug: string }>) {
      if (existsSync(join(r.brandKits, slug, "brand.json")) || !due(`kit:${slug}`)) continue;
      if ((await restoreFolder(m.store, `${keys.brandKits(m.user.id)}${slug}/`, join(r.brandKits, slug))) === 0) miss(`kit:${slug}`);
    }
    for (const { id } of tracks.data as Array<{ id: string }>) {
      const file = `${id}.mp3`;
      if (existsSync(join(r.uploads, file)) || !due(`track:${id}`)) continue;
      await m.store.getToFile(`${keys.music(m.user.id)}${file}`, join(r.uploads, file)).catch(() => miss(`track:${id}`));
    }
  } catch (err) {
    throw unavailable(err);
  }
}

/** A short-lived link to one of the user's stored run files, or null when there is no bucket. */
export async function storedRunFile(runId: string, published: string): Promise<string | null> {
  const m = mine();
  return m ? m.store.link(`${keys.run(m.user.id, runId)}${published}`) : null;
}

export type StoredRun = { runId: string; topic: string; state: string; createdAt: string; stored: boolean };

/** The user's runs as the database lists them (row-level security: only their own). Empty without accounts. */
export async function runRows(): Promise<StoredRun[]> {
  if (!currentUser()) return [];
  const { data, error } = await userDb().from("runs").select("id,topic,state,created_at,stored_at").order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ runId: r.id as string, topic: r.topic as string, state: r.state as string, createdAt: r.created_at as string, stored: !!r.stored_at }));
}

/** Whether a run that is not on this disk is the user's and kept in the bucket (so it can be brought back). */
export async function isStoredRun(runId: string): Promise<boolean> {
  if (!mine()) return false;
  const { data } = await userDb().from("runs").select("stored_at").eq("id", runId).maybeSingle();
  return !!data?.stored_at;
}
