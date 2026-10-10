import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { DEFAULT_SCENE_SECONDS, DEFAULT_VIDEO_SECONDS } from "@src/duration";
import { multiTenant } from "@/lib/accounts";
import { type Cadence, CADENCES, episodeTopic, type SeriesView } from "@/lib/series";
import { createDraft } from "./actions";
import { setSeriesPublishing } from "./channels";
import { ApiError } from "./http";
import type { JobView } from "./jobs";
import { listRuns } from "./runs";
import { Recipe } from "./schemas";
import { roots } from "./config";
import { userDb, UUID } from "./tenant";

/*
 * Series (phase 6 spec §3, §8): a recipe for videos of one kind, kept in the database as the user's, so that
 * the next one is a click. Only in a studio with accounts. Nothing here spends in a new way: an episode is the
 * ordinary paid draft, with a topic built from the series.
 */

export const NewSeries = z.object({
  name: z.string().trim().min(1).max(80),
  premise: z.string().trim().min(1).max(300),
  recipe: Recipe,
});
export type NewSeries = z.infer<typeof NewSeries>;

/** A series' schedule: how often. Setting one is its owner's approval for it to make videos by itself, from the credit they have. */
export const Schedule = z.object({ cadence: z.enum(["manual", "weekly3", "daily", "daily2"]) }).strict();
export type Schedule = z.infer<typeof Schedule>;
export const SeriesChange = z.union([
  z.object({ schedule: Schedule }),
  z.object({ active: z.boolean() }),
  z.object({ publishing: z.object({ channelId: z.string().nullable(), reviewFirst: z.boolean() }) }),
]);

const REFUSALS: Record<string, () => ApiError> = {
  invalid_schedule: () => new ApiError("validation", "that is not a schedule a series can have"),
  not_found: () => new ApiError("not_found", "no such series"),
  too_many_series: () => new ApiError("validation", "an account can have twenty series", "remove one you no longer use"),
  invalid_series: () => new ApiError("validation", "the series could not be saved as it was given"),
  unauthenticated: () => new ApiError("unauthenticated", "sign in first"),
};
const refused = (what: string, message: string): Error => REFUSALS[message]?.() ?? new Error(`${what}: ${message}`);

function accounts(): void {
  if (!multiTenant()) throw new ApiError("not_found", "this studio has no series");
}

type Row = {
  id: string; name: string; premise: string; recipe: unknown; created_at: string;
  cadence: string; status: string; paused_reason: string | null; next_due_at: string | null;
  channel_id: string | null; review_first: boolean;
};
const FIELDS = "id,name,premise,recipe,created_at,cadence,status,paused_reason,next_due_at,channel_id,review_first";

/** A row as the pages show it. A recipe saved by an older form is read with today's defaults; one that no longer parses shows as what the form starts with. */
function view(row: Row, episodes: SeriesView["episodes"], monthUsd: number): SeriesView {
  const recipe = Recipe.safeParse(row.recipe);
  return {
    id: row.id, name: row.name, premise: row.premise, createdAt: row.created_at, episodes, monthUsd,
    cadence: (Object.hasOwn(CADENCES, row.cadence) ? row.cadence : "manual") as Cadence,
    active: row.status === "active", pausedReason: row.paused_reason, nextDueAt: row.next_due_at,
    channelId: row.channel_id, reviewFirst: row.review_first,
    style: recipe.success ? recipe.data.style : "auto", aspect: recipe.success ? recipe.data.aspect : "9:16", durationSec: recipe.success ? recipe.data.durationSec : DEFAULT_VIDEO_SECONDS, sceneSec: recipe.success ? recipe.data.sceneSec : DEFAULT_SCENE_SECONDS,
  };
}

/** The caller's series, newest first, each with its videos (oldest first). */
export async function listSeries(): Promise<SeriesView[]> {
  accounts();
  const db = userDb();
  const [series, tied, held, runs] = await Promise.all([
    db.from("series").select(FIELDS).order("created_at", { ascending: false }),
    db.from("runs").select("id,series_id,charged_usd,created_at").order("created_at"),
    db.from("reservations").select("run_id,cap_usd").eq("status", "open"),
    listRuns(),
  ]);
  if (series.error) throw new Error(`reading series: ${series.error.message}`);
  if (tied.error) throw new Error(`reading runs: ${tied.error.message}`);
  if (held.error) throw new Error(`reading what is held: ${held.error.message}`);
  const known = new Map(runs.map((r) => [r.runId, r]));
  const holding = new Map(((held.data ?? []) as Array<{ run_id: string; cap_usd: string | number }>).map((h) => [h.run_id, Number(h.cap_usd)]));
  // the calendar month (UTC)
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return ((series.data ?? []) as Row[]).map((row) => {
    const mine = ((tied.data ?? []) as Array<{ id: string; series_id: string | null; charged_usd: string | number; created_at: string }>).filter((t) => t.series_id === row.id);
    // in ten-thousandths, the unit amounts are kept in: sums of dollars as floats drift
    const units = mine.reduce((sum, t) => sum + (new Date(t.created_at).getTime() >= monthStart ? Math.round(Number(t.charged_usd) * 10_000) : 0) + Math.round((holding.get(t.id) ?? 0) * 10_000), 0);
    return view(row, mine.map((t) => {
      const run = known.get(t.id);
      return { runId: t.id, title: run?.title, state: run?.state ?? "creating", spendUsd: run?.spendUsd };
    }), units / 10_000);
  });
}

/** One of the caller's series. Someone else's does not exist. */
export async function getSeries(id: string): Promise<SeriesView> {
  if (!UUID.test(id)) throw REFUSALS.not_found();
  const found = (await listSeries()).find((s) => s.id === id);
  if (!found) throw REFUSALS.not_found();
  return found;
}

export async function createSeries(input: NewSeries): Promise<{ id: string }> {
  accounts();
  const { data, error } = await userDb().rpc("create_series", { p_name: input.name, p_premise: input.premise, p_recipe: input.recipe });
  if (error) throw refused("create_series", error.message);
  return { id: String(data) };
}

export async function removeSeries(id: string): Promise<void> {
  accounts();
  if (!UUID.test(id)) throw REFUSALS.not_found();
  const { error } = await userDb().rpc("remove_series", { p_id: id });
  if (error) throw refused("remove_series", error.message);
}

/** Sets or takes away a series' schedule and the approval that goes with it, or stops it or lets it go on. */
export async function changeSeries(id: string, change: z.infer<typeof SeriesChange>): Promise<void> {
  accounts();
  if (!UUID.test(id)) throw REFUSALS.not_found();
  if ("publishing" in change) return setSeriesPublishing(id, change.publishing.channelId, change.publishing.reviewFirst);
  if ("schedule" in change) {
    const sch = change.schedule;
    const { error } = await userDb().rpc("set_series_schedule", { p_id: id, p_cadence: sch.cadence });
    if (error) throw refused("set_series_schedule", error.message);
    // The worker drives a series only when its owner's folder is on its disk (the studio that holds the user's
    // files is the one that makes their videos): a user who has made nothing yet has none until now.
    if (sch.cadence !== "manual") await mkdir(roots().runs, { recursive: true });
    return;
  }
  const { error } = await userDb().rpc("set_series_status", { p_id: id, p_active: change.active });
  if (error) throw refused("set_series_status", error.message);
}

/**
 * Starts the series' next video: the ordinary paid draft (the script, held from the caller's credit as ever),
 * with the series' recipe and a topic built from its premise and what it has already made.
 */
export async function nextEpisode(id: string): Promise<{ runId: string; job: JobView }> {
  accounts();
  if (!UUID.test(id)) throw REFUSALS.not_found();
  const db = userDb();
  const { data, error } = await db.from("series").select(FIELDS).eq("id", id).maybeSingle();
  if (error) throw new Error(`reading the series: ${error.message}`);
  if (!data) throw REFUSALS.not_found();
  const recipe = Recipe.safeParse((data as Row).recipe);
  if (!recipe.success) throw new ApiError("validation", "this series was saved by an older form and can no longer be read", "make it again");
  const earlier = (await getSeries(id)).episodes.map((e) => e.title).filter((t): t is string => !!t);
  return createDraft({ ...recipe.data, topic: episodeTopic((data as Row).premise, earlier) }, id);
}
