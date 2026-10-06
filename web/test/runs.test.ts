import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobView } from "@/server/jobs";
import { listRuns, preview, readRun, runDir, stateOf } from "@/server/runs";
import { draftManifest, finishedManifest, nextRunId, saveRun, useStudio } from "./helpers";

const studio = useStudio();
const job = (extra: Partial<JobView>): JobView =>
  ({ id: "j", kind: "generate", args: [], pid: 1, startedAt: "t", state: "ended", exitCode: 0, ...extra }) as JobView;

describe("run state", () => {
  it("is derived from the manifest and the last job", () => {
    const draft = draftManifest("r");
    const finished = finishedManifest("r");
    const failed = finishedManifest("r");
    failed.scenes[0].stages.clips = { status: "failed", inputHash: "h", costUsd: 0, finishedAt: "t", error: "boom" };
    const half = finishedManifest("r");
    delete half.final;

    expect(stateOf(null, job({ state: "running" }))).toBe("running");
    expect(stateOf(null, null)).toBe("creating");
    expect(stateOf(null, job({ state: "ended", exitCode: 1 }))).toBe("failed"); // the draft could not be created
    expect(stateOf(draft, null)).toBe("draft");
    expect(stateOf(draft, job({ state: "ended", exitCode: 0 }))).toBe("draft");
    expect(stateOf(draft, job({ state: "running" }))).toBe("running");
    expect(stateOf(draft, job({ state: "ended", exitCode: 2 }))).toBe("needs_approval");
    expect(stateOf(draft, job({ state: "interrupted" }))).toBe("interrupted");
    expect(stateOf(finished, null)).toBe("done");
    expect(stateOf(finished, job({ state: "ended", exitCode: 0 }))).toBe("done");
    expect(stateOf(failed, job({ state: "ended", exitCode: 1 }))).toBe("failed");
    expect(stateOf(half, job({ state: "ended", exitCode: 1 }))).toBe("failed");
    expect(stateOf(half, job({ state: "stopped" }))).toBe("incomplete");
    expect(stateOf(half, null)).toBe("incomplete");
  });
});

describe("reading runs", () => {
  it("accepts run ids only: nothing path-like reaches the file system", () => {
    expect(runDir("20261006-133244-b46307")).toBe(join(studio.runs, "20261006-133244-b46307"));
    for (const bad of ["..", "../etc", "20261006-133244-b46307/..", "", "a".repeat(22)]) {
      expect(() => runDir(bad)).toThrow("no run");
    }
  });

  it("lists every run newest first, and shows an unreadable folder as failed instead of hiding it", async () => {
    const older = draftManifest("20261001-090000-aaaaaa");
    const newer = finishedManifest("20261002-090000-bbbbbb");
    await saveRun(studio, older);
    await saveRun(studio, newer);
    await mkdir(join(studio.runs, "20261003-090000-cccccc"));
    await writeFile(join(studio.runs, "20261003-090000-cccccc", "manifest.json"), '{"schemaVersion":1}');
    await mkdir(join(studio.runs, "not-a-run"));
    const runs = await listRuns();
    expect(runs.map((r) => [r.runId, r.state])).toEqual([
      ["20261003-090000-cccccc", "failed"],
      ["20261002-090000-bbbbbb", "done"],
      ["20261001-090000-aaaaaa", "draft"],
    ]);
    expect(runs[1]).toMatchObject({ topic: "foxes at night", title: "Fake run", sceneCount: 3, spendUsd: 0.0255 });
  });

  it("an unknown run is not found; one still being created has a job and no status", async () => {
    await expect(readRun(nextRunId())).rejects.toMatchObject({ code: "not_found" });
    const id = nextRunId();
    await mkdir(join(studio.runs, id));
    await writeFile(join(studio.runs, id, "job.json"), JSON.stringify({ id: "j", kind: "draft", args: [], pid: process.pid, startedAt: "t" }));
    const view = await readRun(id);
    expect(view.state).toBe("running");
    expect(view.status).toBeUndefined();
  });
});

describe("preview", () => {
  it("is the draft stand-in until all media exists, then the real media", async () => {
    const id = nextRunId();
    const draft = preview(draftManifest(id), id);
    expect(draft.draft).toBe(true);
    expect(draft.props.scenes[0].src).toBe("draft/scene_01.svg");

    const real = preview(finishedManifest(id), id);
    expect(real.draft).toBe(false);
    expect(real.props.scenes.map((s) => s.src)).toEqual(["fitted/scene_01.mp4", "fitted/scene_02.mp4", "images/keyframe_03.png"]);
    expect(real.files["fitted/scene_01.mp4"]).toBe(join(studio.runs, id, "fitted/scene_01.mp4"));
    expect(real.files["sfx/whoosh.mp3"] ?? real.files["sfx/impact_boom.mp3"]).toContain(join(studio.root, "assets/sfx"));

    // bought half-way (a clip is missing): still previewable, as a draft
    const half = finishedManifest(id);
    delete half.scenes[1].fitted;
    expect(preview(half, id).draft).toBe(true);
  });

  it("applies a pending look without saving anything", () => {
    const id = nextRunId();
    const m = finishedManifest(id);
    expect(preview(m, id, { hook: false }).props.hook).toBeNull();
    expect(m.request.render.hook).toBe(true);
  });
});
