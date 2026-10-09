import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Db } from "@src/db/client";
import { multiTenant } from "../lib/accounts";

/*
 * The worker's side of accounts: it has no user session, so it talks to the database with the service role —
 * the one key that may settle a reservation. That key exists in the worker's environment only, and is never
 * handed on to the CLI it starts.
 */

export type Reservation = { id: string; user_id: string; run_id: string; kind: string; cap_usd: number; status: string; created_at: string };

export type TenantDb = {
  reservation(id: string): Promise<Reservation | null>;
  /** Open reservations older than `ageMs` (younger ones may belong to a job that is just being queued). */
  openReservations(ageMs: number): Promise<Reservation[]>;
  /** The open reservation of one run, if it has one. */
  openReservationFor(runId: string): Promise<Reservation | null>;
  /** What has been charged for a run so far (0 for a run the database does not know). */
  chargedFor(runId: string): Promise<number>;
  /** Closes a reservation at what its run has spent in all; returns the amount charged. */
  settle(id: string, runTotalUsd: number): Promise<number>;
  /** `state: null` leaves the state as it is (only the time of the last store is recorded). */
  setRunState(runId: string, state: string | null, storedAt?: string): Promise<void>;
};

let pool: { url: string; db: Db } | undefined;

/** The worker's connection, as the role that may settle and fulfil (`studio_worker`); one pool per process. */
export function workerDb(): Db {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set: with accounts the worker needs it to settle what jobs cost");
  if (pool?.url !== url) pool = { url, db: Db.connect(url, { max: 5 }) };
  return pool.db;
}

/** The database as the worker uses it, or null in a studio without accounts. */
export function tenantDb(): TenantDb | null {
  if (!multiTenant()) return null;
  // the worker's own address of the database: it signs in as `studio_worker`, the one role that may settle
  const db = workerDb();
  const row = (r: Record<string, unknown>): Reservation => ({ ...(r as Reservation), cap_usd: Number(r.cap_usd) });
  const FIELDS = "id,user_id,run_id,kind,cap_usd,status,created_at";
  return {
    async reservation(id) {
      const { data, error } = await db.from("reservations").select(FIELDS).eq("id", id).maybeSingle();
      if (error) throw new Error(`reading a reservation: ${error.message}`);
      return data ? row(data) : null;
    },
    async openReservations(ageMs) {
      const before = new Date(Date.now() - ageMs).toISOString();
      const { data, error } = await db.from("reservations").select(FIELDS).eq("status", "open").lt("created_at", before).order("created_at");
      if (error) throw new Error(`listing open reservations: ${error.message}`);
      return (data ?? []).map(row);
    },
    async openReservationFor(runId) {
      const { data, error } = await db.from("reservations").select(FIELDS).eq("run_id", runId).eq("status", "open").maybeSingle();
      if (error) throw new Error(`reading a run's reservation: ${error.message}`);
      return data ? row(data) : null;
    },
    async chargedFor(runId) {
      const { data, error } = await db.from("runs").select("charged_usd").eq("id", runId).maybeSingle();
      if (error) throw new Error(`reading what a run was charged: ${error.message}`);
      return data ? Number(data.charged_usd) : 0;
    },
    async settle(id, runTotalUsd) {
      const { data, error } = await db.rpc("settle", { p_reservation_id: id, p_run_total_usd: runTotalUsd });
      if (error) throw new Error(`settling a reservation: ${error.message}`);
      return Number(data);
    },
    async setRunState(runId, state, storedAt) {
      const { error } = await db.rpc("set_run_state", { p_run_id: runId, p_state: state, ...(storedAt ? { p_stored_at: storedAt } : {}) });
      if (error) throw new Error(`recording a run's state: ${error.message}`);
    },
  };
}

/**
 * What a run has spent in all, from its manifest: its ledger, plus every provider call that was made and has
 * not been charged yet (a submitted job, a narration or script request in flight). A submitted job is billed by the provider whether or not anyone waits for it, so a run
 * stopped (or a worker killed) between submit and result has spent that money already; when the job is later
 * collected, its ledger entry takes the place of this figure; when it is given up for a new one instead, its
 * cost stays on record (`abandonedUsd`).
 *
 * `null` when the run has no manifest at all, `undefined` when the manifest cannot be read (then nothing is
 * settled on a guess).
 */
export function spendOf(runDir: string): number | null | undefined {
  const file = join(runDir, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      ledger?: Array<{ usd?: unknown }>;
      inFlight?: Record<string, unknown>;
      abandonedUsd?: unknown;
      scenes?: Array<{ abandonedUsd?: unknown; jobs?: Record<string, { expectedUsd?: unknown; chargedUsd?: unknown; result?: unknown } | undefined> }>;
    };
    const amount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Number.NaN);
    let total = (manifest.ledger ?? []).reduce((sum, e) => sum + amount(e.usd), 0);
    // narration or a script that was on its way when the process was ended, and such calls that were made again since
    for (const usd of Object.values(manifest.inFlight ?? {})) total += amount(usd);
    if (manifest.abandonedUsd !== undefined) total += amount(manifest.abandonedUsd);
    for (const scene of manifest.scenes ?? []) {
      // jobs submitted and then given up for a new one (a reroll while one was in flight): billed, and no longer in `jobs`
      if (scene.abandonedUsd !== undefined) total += amount(scene.abandonedUsd);
      for (const job of Object.values(scene.jobs ?? {})) {
        // submitted, not collected: no result and nothing charged yet
        if (job && job.result === undefined && !(amount(job.chargedUsd) > 0) && job.expectedUsd !== undefined) total += amount(job.expectedUsd);
      }
    }
    return Number.isFinite(total) ? Math.round(total * 10_000) / 10_000 : undefined;
  } catch {
    return undefined;
  }
}
