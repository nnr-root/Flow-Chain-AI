import { z } from "zod";
import { multiTenant } from "@/lib/accounts";
import { episodeTopic, type SeriesView } from "@/lib/series";
import { createDraft } from "./actions";
import { ApiError } from "./http";
import type { JobView } from "./jobs";
import { listRuns } from "./runs";
import { NewVideo } from "./schemas";
import { userDb, UUID } from "./tenant";

/*
 * Series (phase 6 spec §3, §8): a recipe for videos of one kind, kept in the database as the user's, so that
 * the next one is a click. Only in a studio with accounts. Nothing here spends in a new way: an episode is the
 * ordinary paid draft, with a topic built from the series.
 */

/** What a series keeps of the new-video form: everything but the topic, which each episode gets built. */
export const Recipe = NewVideo.omit({ topic: true });
export type Recipe = z.infer<typeof Recipe>;

export const NewSeries = z.object({
  name: z.string().trim().min(1).max(80),
  premise: z.string().trim().min(1).max(300),
  recipe: Recipe,
});
export type NewSeries = z.infer<typeof NewSeries>;

const REFUSALS: Record<string, () => ApiError> = {
  not_found: () => new ApiError("not_found", "no such series"),
  too_many_series: () => new ApiError("validation", "an account can have twenty series", "remove one you no longer use"),
  invalid_series: () => new ApiError("validation", "the series could not be saved as it was given"),
  unauthenticated: () => new ApiError("unauthenticated", "sign in first"),
};
const refused = (what: string, message: string): Error => REFUSALS[message]?.() ?? new Error(`${what}: ${message}`);

function accounts(): void {
  if (!multiTenant()) throw new ApiError("not_found", "this studio has no series");
}

type Row = { id: string; name: string; premise: string; recipe: unknown; created_at: string };

/** A row as the pages show it. A recipe saved by an older form is read with today's defaults; one that no longer parses shows as what the form starts with. */
function view(row: Row, episodes: SeriesView["episodes"]): SeriesView {
  const recipe = Recipe.safeParse(row.recipe);
  return {
    id: row.id, name: row.name, premise: row.premise, createdAt: row.created_at, episodes,
    style: recipe.success ? recipe.data.style : "auto", aspect: recipe.success ? recipe.data.aspect : "9:16", scenes: recipe.success ? recipe.data.scenes : 4,
  };
}

/** The caller's series, newest first, each with its videos (oldest first). */
export async function listSeries(): Promise<SeriesView[]> {
  accounts();
  const db = userDb();
  const [series, tied, runs] = await Promise.all([
    db.from("series").select("id,name,premise,recipe,created_at").order("created_at", { ascending: false }),
    db.from("runs").select("id,series_id").order("created_at"),
    listRuns(),
  ]);
  if (series.error) throw new Error(`reading series: ${series.error.message}`);
  if (tied.error) throw new Error(`reading runs: ${tied.error.message}`);
  const known = new Map(runs.map((r) => [r.runId, r]));
  return ((series.data ?? []) as Row[]).map((row) =>
    view(row, ((tied.data ?? []) as Array<{ id: string; series_id: string | null }>).filter((t) => t.series_id === row.id).map((t) => {
      const run = known.get(t.id);
      return { runId: t.id, title: run?.title, state: run?.state ?? "creating", spendUsd: run?.spendUsd };
    })),
  );
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

/**
 * Starts the series' next video: the ordinary paid draft (the script, held from the caller's credit as ever),
 * with the series' recipe and a topic built from its premise and what it has already made.
 */
export async function nextEpisode(id: string): Promise<{ runId: string; job: JobView }> {
  accounts();
  if (!UUID.test(id)) throw REFUSALS.not_found();
  const db = userDb();
  const { data, error } = await db.from("series").select("id,name,premise,recipe,created_at").eq("id", id).maybeSingle();
  if (error) throw new Error(`reading the series: ${error.message}`);
  if (!data) throw REFUSALS.not_found();
  const recipe = Recipe.safeParse((data as Row).recipe);
  if (!recipe.success) throw new ApiError("validation", "this series was saved by an older form and can no longer be read", "make it again");
  const earlier = (await getSeries(id)).episodes.map((e) => e.title).filter((t): t is string => !!t);
  return createDraft({ ...recipe.data, topic: episodeTopic((data as Row).premise, earlier) }, id);
}
