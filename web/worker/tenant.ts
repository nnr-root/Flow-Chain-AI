import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { multiTenant } from "../lib/supabase/settings";

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
  /** Closes a reservation at what its run has spent in all; returns the amount charged. */
  settle(id: string, runTotalUsd: number): Promise<number>;
  /** `state: null` leaves the state as it is (only the time of the last store is recorded). */
  setRunState(runId: string, state: string | null, storedAt?: string): Promise<void>;
};

/** The database as the worker uses it, or null in a studio without accounts. */
export function tenantDb(): TenantDb | null {
  if (!multiTenant()) return null;
  const url = process.env.SUPABASE_URL!.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set: with accounts the worker needs it to settle what jobs cost");
  const db: SupabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
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
 * What a run has spent in all, from its manifest's ledger: 0 when the run never got a manifest, undefined when
 * the manifest cannot be read (then nothing is settled on a guess).
 */
export function spendOf(runDir: string): number | undefined {
  const file = join(runDir, "manifest.json");
  if (!existsSync(file)) return 0;
  try {
    const ledger = (JSON.parse(readFileSync(file, "utf8")) as { ledger?: Array<{ usd?: unknown }> }).ledger ?? [];
    const total = ledger.reduce((sum, e) => sum + (typeof e.usd === "number" && Number.isFinite(e.usd) ? e.usd : Number.NaN), 0);
    return Number.isFinite(total) ? Math.round(total * 10_000) / 10_000 : undefined;
  } catch {
    return undefined;
  }
}
