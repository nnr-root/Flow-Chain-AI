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
  const store = user ? objectStore() : null;
  return user && store ? { user, store } : null;
}

const unavailable = (err: unknown) =>
  new ApiError("storage_unavailable", "the studio's storage could not be reached", `nothing was saved; try again in a moment (${err instanceof Error ? err.message : String(err)})`);

/**
 * Makes an uploaded brand kit last: its files go to the bucket and the kit is registered as the user's. If either
 * fails the kit is removed again, so nothing exists on this disk alone.
 */
export async function keepBrandKit(slug: string, name: string): Promise<void> {
  const m = mine();
  if (!m) return;
  const dir = join(roots().brandKits, slug);
  try {
    await storeFolder(m.store, dir, `${keys.brandKits(m.user.id)}${slug}/`);
    const { error } = await userDb().rpc("register_brand_kit", { p_slug: slug, p_name: name });
    if (error) throw new Error(error.message);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw unavailable(err);
  }
}

export async function keepTrack(file: string, name: string, bytes: number): Promise<void> {
  const m = mine();
  if (!m) return;
  const path = join(roots().uploads, file);
  try {
    await m.store.putFile(`${keys.music(m.user.id)}${file}`, path);
    const { error } = await userDb().rpc("register_track", { p_id: file.replace(/\.mp3$/, "").toLowerCase(), p_name: name, p_bytes: bytes });
    if (error) throw new Error(error.message);
  } catch (err) {
    await rm(path, { force: true });
    throw unavailable(err);
  }
}

/**
 * Brings the user's kits and tracks onto this disk when the database knows of more than the disk holds (a new
 * server, a disk that was cleaned). Costs one small query when nothing is missing.
 */
export async function bringLibrary(): Promise<void> {
  const m = mine();
  if (!m) return;
  const r = roots();
  const [kits, tracks] = await Promise.all([userDb().from("brand_kits").select("slug"), userDb().from("music_tracks").select("id")]);
  if ((kits.data ?? []).some((k) => !existsSync(join(r.brandKits, k.slug as string, "brand.json")))) {
    await restoreFolder(m.store, keys.brandKits(m.user.id), r.brandKits).catch((err) => { throw unavailable(err); });
  }
  if ((tracks.data ?? []).some((t) => !existsSync(join(r.uploads, `${t.id as string}.mp3`)))) {
    await restoreFolder(m.store, keys.music(m.user.id), r.uploads).catch((err) => { throw unavailable(err); });
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
