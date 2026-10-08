import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FPS, outputSize } from "@src/config";
import type { Manifest } from "@src/manifest/schema";
import { loadManifest } from "@src/manifest/store";
import type { RenderInputs, RenderPropsOptions } from "@src/stages/build-render-props";
import { RUN_ID } from "@src/studio/commands";
import { buildDraftProps, type LookFlags, previewProps } from "@src/studio/props";
import { type RunStatus, statusOf } from "@src/studio/status";
import { roots } from "./config";
import { ApiError } from "./http";
import { type JobView, runner, viewJob } from "./jobs";
import { isStoredRun, runRows } from "./store/tenant";

/** `stored`: only in the list of a studio with accounts — the run is kept in the bucket and not on this disk; opening it brings it back. */
export type RunState = "creating" | "draft" | "queued" | "running" | "needs_approval" | "failed" | "interrupted" | "done" | "incomplete" | "stored";

export type RunView = {
  runId: string;
  state: RunState;
  job: JobView | null;
  /** The pipeline's lock was left behind by a process that is gone, and no job runs: it can be cleared from the page. */
  staleLock: boolean;
  /** Absent while the run is still being created (no manifest yet). */
  status?: RunStatus;
};

/** A run's folder; ids that are not run ids (anything path-like) do not exist as far as the studio is concerned. */
export function runDir(runId: string): string {
  if (!RUN_ID.test(runId)) throw new ApiError("not_found", `no run ${runId}`);
  return join(roots().runs, runId);
}

/** Derived from the manifest and the last job; never stored (spec §3.3). */
export function stateOf(m: Manifest | null, job: JobView | null): RunState {
  if (job?.state === "running") return "running";
  if (job?.state === "queued") return "queued";
  if (!m) return job ? "failed" : "creating";
  if (job?.state === "interrupted") return "interrupted";
  // exit code 2 is the CLI's "the estimate was not confirmed": the plan exceeded what was approved
  if (job?.state === "ended" && job.exitCode === 2) return "needs_approval";
  const failedStep = [...Object.values(m.runStages), ...m.scenes.flatMap((s) => Object.values(s.stages))].some((r) => r?.status === "failed");
  if (failedStep || (job?.state === "ended" && job.exitCode !== 0)) return "failed";
  if (statusOf(m).draft) return "draft";
  if (m.final && m.runStages.render?.status === "done") return "done";
  // stopped, or left unfinished from the terminal: resumable
  return "incomplete";
}

export async function readManifest(runId: string): Promise<Manifest | null> {
  const dir = runDir(runId);
  if (!existsSync(join(dir, "manifest.json"))) return null;
  return loadManifest(dir);
}

/**
 * A run that is the user's but not on this disk (a new server, a disk that was cleaned) is fetched back from the
 * bucket before anything looks at it. Returns whether it was.
 */
async function bringBack(runId: string): Promise<boolean> {
  // a folder without its manifest is no run yet (a restore that was cut off): it is fetched again, not taken as is
  if (existsSync(join(runDir(runId), "manifest.json")) || !(await isStoredRun(runId))) return false;
  await runner().restore(runId);
  return existsSync(join(runDir(runId), "manifest.json"));
}

export async function readRun(runId: string): Promise<RunView> {
  runDir(runId);
  const job = await viewJob(runId);
  let manifest = await readManifest(runId);
  if (!manifest && !job && (await bringBack(runId))) manifest = await readManifest(runId);
  if (!manifest && !job) throw new ApiError("not_found", `no run ${runId}`);
  const staleLock = await runner().staleLock(runId, job);
  return { runId, state: stateOf(manifest, job), job, staleLock, ...(manifest ? { status: statusOf(manifest) } : {}) };
}

/** A run that must have a manifest (every action but watching a draft being created). */
export async function requireManifest(runId: string): Promise<Manifest> {
  let manifest = await readManifest(runId);
  if (!manifest && (await bringBack(runId))) manifest = await readManifest(runId);
  if (!manifest) throw new ApiError("not_found", `run ${runId} has no manifest yet`);
  return manifest;
}

export type RunSummary = {
  runId: string;
  state: RunState;
  topic?: string;
  title?: string;
  createdAt?: string;
  aspect?: string;
  sceneCount?: number;
  spendUsd?: number;
  /** A published path under the run's files route, when a picture exists. */
  thumbnail?: string;
};

/** Every run, newest first. Folders the studio cannot read (older schema, half-written) are listed as failed, not hidden. */
export async function listRuns(): Promise<RunSummary[]> {
  const local = await localRuns();
  // with accounts: what the database lists as stored and this disk does not hold whole is kept in the bucket
  const { runs } = roots();
  const away = (await runRows())
    .filter((r) => r.stored && !existsSync(join(runs, r.runId, "manifest.json")))
    .map((r): RunSummary => ({ runId: r.runId, state: "stored", topic: r.topic, createdAt: r.createdAt }));
  const archived = new Set(away.map((r) => r.runId));
  return [...local.filter((r) => !archived.has(r.runId)), ...away].sort((x, y) => (x.runId < y.runId ? 1 : -1));
}

async function localRuns(): Promise<RunSummary[]> {
  const { runs } = roots();
  if (!existsSync(runs)) return [];
  const ids = (await readdir(runs)).filter((id) => RUN_ID.test(id)).sort().reverse();
  return Promise.all(
    ids.map(async (runId): Promise<RunSummary> => {
      try {
        const { state, status } = await readRun(runId);
        const thumbnail = existsSync(join(runs, runId, "images/keyframe_01.png")) ? "images/keyframe_01.png" : undefined;
        return status
          ? {
              runId, state, topic: status.topic, title: status.title, createdAt: status.createdAt, aspect: status.aspect,
              sceneCount: status.sceneCount, spendUsd: status.spendUsd, thumbnail,
            }
          : { runId, state };
      } catch {
        return { runId, state: "failed" };
      }
    }),
  );
}

export function propsOptions(m: Manifest, runId: string, brandDir?: string): RenderPropsOptions {
  const r = roots();
  return { dir: join(r.runs, runId), fontsDir: r.fonts, sfxDir: r.sfx, fps: FPS, size: outputSize(m.request.aspect), brandDir };
}

export type Preview = RenderInputs & { draft: boolean };

/**
 * Player props for a run: the real media when all of it exists, otherwise the draft stand-ins (a run that
 * failed half-way previews as a draft until it is complete).
 */
export function preview(m: Manifest, runId: string, flags: LookFlags = {}, brandDir?: string): Preview {
  if (!m.script) throw new ApiError("not_found", `run ${runId} has no script yet`);
  const opts = propsOptions(m, runId, brandDir);
  if (!statusOf(m).draft) {
    try {
      return { ...previewProps(m, opts, flags), draft: false };
    } catch {
      // some media is missing: fall through to the draft preview
    }
  }
  return { ...buildDraftProps(m, opts, flags), draft: true };
}
