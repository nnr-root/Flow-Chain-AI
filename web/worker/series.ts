import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Queue } from "bullmq";
import type { Db } from "@src/db/client";
import { newRunId } from "@src/manifest/store";
import { DRAFT_CAP_USD, round4 } from "../lib/credit";
import { episodeTopic } from "../lib/series";
import { JOB_OPTIONS, type RunJobData } from "../server/jobs/redis";
import { runFolder, runShort } from "../server/jobs/run-cli";
import { draftArgs, Recipe } from "../server/schemas";

/*
 * Series that make their videos by themselves (phase 6 spec §4–5). The worker is the one process that may start
 * paid work, so it is the worker that looks, every so often, at each series with a schedule and takes its next
 * step: begin a video that is due, or go on with the one being made once its script is written and priced.
 *
 * It decides nothing about money. Whether a step may be taken is the database's answer (`start_series_episode`,
 * `reserve_for_series`): a schedule is its owner's standing approval, and those functions hold credit only for
 * a series that has one, out of the credit its owner has. What this file adds is the order of the steps, and
 * saying why a series stopped (phase 6 spec §15: there is no limit for a video or a month any more). The jobs it queues are the same two a user's clicks queue, and are checked the same way before they run.
 */

type SeriesRow = {
  id: string; user_id: string; premise: string; recipe: unknown; cadence: string;
  next_due_at: string | null; current_run: string | null; current_step: string | null;
};

/** Why a series is stopped, by what the database refused with. Anything not here is tried again at the next look. */
const PAUSES: Record<string, "credit"> = { insufficient_credit: "credit" };

export type AutopilotDeps = {
  db: Db;
  line: Queue<RunJobData>;
  /** Runs `work` with every path being that user's own. */
  asUser: <T>(userId: string, work: () => Promise<T>) => Promise<T>;
  /**
   * Whether that user's folder is on this worker's disk. A series is driven only by the studio that holds its
   * owner's files: two studios on one database (a developer's tests beside their local studio, which has real
   * provider keys) must not make each other's videos. The web app makes the folder when a schedule is approved.
   */
  here: (userId: string) => boolean;
  /** Carries out a post (this worker publishes); absent where it does not. */
  post?: (postId: string) => Promise<unknown>;
  /** Whether this worker has that run's CLI running or starting right now. */
  busy: (runId: string) => boolean;
  log: (message: string) => void;
};

export function autopilot({ db, line, asUser, here, post, busy, log }: AutopilotDeps): { tick: () => Promise<void> } {
  const ask = async (name: string, args: Record<string, unknown>): Promise<{ data?: unknown; refused?: string }> => {
    const { data, error } = await db.rpc(name, args);
    return error ? { refused: error.message } : { data };
  };
  const finish = async (s: SeriesRow, runId: string, pause: "credit" | "failed" | null, why: string): Promise<void> => {
    const { refused } = await ask("finish_series_episode", { p_series_id: s.id, p_run_id: runId, p_pause: pause });
    if (refused) throw new Error(`finish_series_episode: ${refused}`);
    log(`worker: series ${s.id}: ${why}${pause ? `; paused (${pause})` : ""}`);
  };
  const enqueue = async (s: SeriesRow, runId: string, kind: "draft" | "generate", args: string[], reservationId: unknown, approvedUsd?: number): Promise<void> => {
    const data: RunJobData = {
      runId, kind, args, enqueuedAt: new Date().toISOString(), token: randomUUID(), userId: s.user_id, reservationId: String(reservationId),
      ...(approvedUsd === undefined ? {} : { approvedUsd }),
    };
    // (the same job, under the same id, that the web app queues for a click: one job per run, never retried)
    await line.add(kind, data, { ...JOB_OPTIONS, jobId: runId });
  };

  /** What a run's manifest says of itself, read in its owner's scope: its title once the script is written. */
  const scriptOf = (runId: string): { title?: string } | null => {
    try {
      const manifest = JSON.parse(readFileSync(join(runFolder(runId), "manifest.json"), "utf8")) as { script?: { title?: unknown } };
      if (!manifest.script) return null;
      return { title: typeof manifest.script.title === "string" ? manifest.script.title : undefined };
    } catch {
      return null;
    }
  };

  /** Goes on with the video a series is making. */
  async function carryOn(s: SeriesRow, runId: string): Promise<void> {
    // waiting in line, or being worked on, or its credit not yet settled: nothing to do until that is over
    if (busy(runId) || (await line.getJob(runId))) return;
    const open = await db.from("reservations").select("id").eq("run_id", runId).eq("status", "open").maybeSingle();
    if (open.error) throw new Error(`reading a run's reservation: ${open.error.message}`);
    if (open.data) return;
    const { made, script } = await asUser(s.user_id, async () => ({ made: existsSync(join(runFolder(runId), "final.mp4")), script: scriptOf(runId) }));
    if (made) {
      await finish(s, runId, null, `${runId} is made`);
      // A series whose owner does not ask to see each video first has it posted now; one that does leaves it
      // with a Publish button on its page. (The database decides which, and whether there is a channel at all.)
      if (post) {
        const asked = await ask("post_for_series", { p_series_id: s.id, p_run_id: runId });
        if (asked.refused) throw new Error(`post_for_series: ${asked.refused}`);
        if (asked.data) await post(String(asked.data));
      }
      return;
    }
    // The job is over and there is no video. Nothing is retried on its own: the series stops and its owner is
    // shown the run, with what went wrong in it.
    if (s.current_step === "generate") return finish(s, runId, "failed", `${runId} was not finished`);
    if (!script) return finish(s, runId, "failed", `the script of ${runId} was not written`);
    // the script is there: what the rest would cost, and whether its owner's credit covers it
    const price = await asUser(s.user_id, async () => round4((JSON.parse(await runShort(["plan", runId, "--json"])) as { totalUsd: number }).totalUsd));
    if (!Number.isFinite(price) || price < 0) throw new Error(`the plan of ${runId} gave no price`);
    const held = await ask("reserve_for_series", { p_series_id: s.id, p_run_id: runId, p_cap_usd: price });
    if (held.refused) {
      const pause = PAUSES[held.refused];
      if (pause) return finish(s, runId, pause, `${runId} could not be paid for (${held.refused})`);
      // (the owner has a job of their own on it, or as many as an account may have: looked at again next time)
      return;
    }
    await enqueue(s, runId, "generate", ["resume", runId, "--budget", String(price), "--cap", String(price)], held.data, price);
    log(`worker: series ${s.id}: generating ${runId}, up to $${price}`);
  }

  /** Begins the next video of a series that is due. */
  async function begin(s: SeriesRow): Promise<void> {
    if (!s.next_due_at || new Date(s.next_due_at).getTime() > Date.now()) return;
    const recipe = Recipe.safeParse(s.recipe);
    if (!recipe.success) return finish(s, "", "failed", "its saved choices can no longer be read");
    const tied = await db.from("runs").select("id").eq("series_id", s.id).order("created_at");
    if (tied.error) throw new Error(`reading a series' runs: ${tied.error.message}`);
    const runId = newRunId();
    const { topic, args } = await asUser(s.user_id, async () => {
      const earlier = ((tied.data ?? []) as Array<{ id: string }>).map((r) => scriptOf(r.id)?.title).filter((t): t is string => !!t);
      const topic = episodeTopic(s.premise, earlier);
      return { topic, args: draftArgs({ ...recipe.data, topic }, runId) };
    });
    const began = await ask("start_series_episode", { p_series_id: s.id, p_run_id: runId, p_topic: topic, p_draft_cap_usd: DRAFT_CAP_USD });
    if (began.refused) {
      const pause = PAUSES[began.refused];
      if (pause) return finish(s, runId, pause, `its next video could not be begun (${began.refused})`);
      // not due after all, busy, or its owner has as many jobs or unstarted videos as an account may: next time
      return;
    }
    await enqueue(s, runId, "draft", args, began.data);
    log(`worker: series ${s.id}: began ${runId}`);
  }

  let looking = false;
  return {
    /** One look at every series with a schedule. A series whose step fails is left as it is, said, and looked at again next time. */
    async tick() {
      // (a look that takes longer than the time between two is not overtaken by the next)
      if (looking) return;
      looking = true;
      try {
        const { data, error } = await db.from("series").select("id,user_id,premise,recipe,cadence,next_due_at,current_run,current_step").eq("status", "active");
        if (error) throw new Error(`listing series: ${error.message}`);
        for (const s of (data ?? []) as SeriesRow[]) {
          if (s.cadence === "manual" || !here(s.user_id)) continue;
          try {
            if (s.current_run) await carryOn(s, s.current_run);
            else await begin(s);
          } catch (err) {
            log(`worker: series ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        log(`worker: could not look at the series: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        looking = false;
      }
    },
  };
}
