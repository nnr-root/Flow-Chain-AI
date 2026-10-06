import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearStaleLock, cliJson, JOB_EXIT, JOB_FILE, JOB_LOG, liveJobs, logTail, readJob, startJob, stopJob } from "@/server/jobs";
import { calls, nextRunId, stub, until, useStudio } from "./helpers";

const studio = useStudio();
const ended = (dir: string) => until(() => (readJob(dir)?.state !== "running" ? readJob(dir) : null));

describe("jobs", () => {
  it("starts the CLI detached with the run's arguments, logs its output and records how it ended", async () => {
    const id = nextRunId();
    const dir = join(studio.runs, id);
    const job = await startJob(id, "generate", ["resume", id, "--budget", "0.3"], 0.3);
    expect(job).toMatchObject({ kind: "generate", state: "running", approvedUsd: 0.3, args: ["resume", id, "--budget", "0.3"] });
    expect(JSON.parse(await readFile(join(dir, JOB_FILE), "utf8")).pid).toBe(job.pid);
    expect(await ended(dir)).toMatchObject({ state: "ended", exitCode: 0 });
    expect(await calls(studio)).toEqual([["resume", id, "--budget", "0.3"]]);
    expect(await readFile(join(dir, JOB_LOG), "utf8")).toContain("▶ resume");
    expect(await logTail(id)).toEqual(["▶ resume"]);
  });

  it("keeps the CLI's exit code: 2 means the estimate was not confirmed", async () => {
    await stub(studio, "_behave.json", { exitCode: 2 });
    const id = nextRunId();
    await startJob(id, "generate", ["resume", id]);
    expect(await ended(join(studio.runs, id))).toMatchObject({ state: "ended", exitCode: 2 });
  });

  it("passes arguments through untouched, whatever characters a topic contains", async () => {
    const id = nextRunId();
    const topic = `it's "quoted"; $(rm -rf /) && \`echo\` \n second line`;
    await startJob(id, "draft", ["run", "--draft", "--run-id", id, "--topic", topic]);
    await ended(join(studio.runs, id));
    expect((await calls(studio))[0]).toEqual(["run", "--draft", "--run-id", id, "--topic", topic]);
  });

  it("allows one job per run: a second start, or the pipeline's own lock, is refused", async () => {
    await stub(studio, "_behave.json", { sleepMs: 3000 });
    const id = nextRunId();
    await startJob(id, "generate", ["resume", id]);
    await expect(startJob(id, "rerender", ["rerender", id])).rejects.toMatchObject({ code: "job_active" });
    await until(async () => (await calls(studio)).length === 1); // the first job did start
    await stopJob(id);

    const locked = nextRunId();
    await mkdir(join(studio.runs, locked), { recursive: true });
    await writeFile(join(studio.runs, locked, ".lock"), `${process.pid}\n`);
    await expect(startJob(locked, "generate", ["resume", locked])).rejects.toMatchObject({ code: "job_active" });
    expect(await calls(studio)).toHaveLength(1);
  });

  it("refuses to run more jobs at once than the machine limit", async () => {
    process.env.STUDIO_MAX_JOBS = "1";
    await stub(studio, "_behave.json", { sleepMs: 3000 });
    const first = nextRunId();
    await startJob(first, "generate", ["resume", first]);
    expect(liveJobs()).toBe(1);
    await expect(startJob(nextRunId(), "generate", ["resume", "x"])).rejects.toMatchObject({ code: "busy" });
    await stopJob(first);
    await until(() => liveJobs() === 0);
  });

  it("stop ends the whole process group and is reported as stopped, not as a failure", async () => {
    await stub(studio, "_behave.json", { sleepMs: 30_000 });
    const id = nextRunId();
    const dir = join(studio.runs, id);
    const job = await startJob(id, "generate", ["resume", id]);
    await until(async () => (await calls(studio)).length === 1);
    await stopJob(id);
    expect(await ended(dir)).toMatchObject({ state: "stopped" });
    expect(existsSync(join(dir, JOB_EXIT))).toBe(false);
    await until(() => {
      try {
        process.kill(job.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await expect(stopJob(id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("a job whose process vanished without an exit code is interrupted (found again after a server restart)", async () => {
    const id = nextRunId();
    const dir = join(studio.runs, id);
    await mkdir(dir, { recursive: true });
    // a pid that cannot exist: what a reboot leaves behind
    await writeFile(join(dir, JOB_FILE), JSON.stringify({ id: "j", kind: "generate", args: [], pid: 2 ** 22 + 12345, startedAt: "t" }));
    expect(readJob(dir)).toMatchObject({ state: "interrupted" });
    // …and one that ended while no web server was watching still has its exit code
    await writeFile(join(dir, JOB_EXIT), "1\n");
    expect(readJob(dir)).toMatchObject({ state: "ended", exitCode: 1 });
  });

  it("clears a stale lock only when nothing of the run is alive", async () => {
    const id = nextRunId();
    const dir = join(studio.runs, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".lock"), `${process.pid}\n`); // this very process: alive
    await expect(clearStaleLock(id)).rejects.toMatchObject({ code: "job_active" });
    await writeFile(join(dir, ".lock"), `${2 ** 22 + 12345}\n`);
    await clearStaleLock(id);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
    await clearStaleLock(id); // nothing to do is not an error
  });

  it("cliJson returns a free command's JSON and turns a failure into a readable error", async () => {
    await stub(studio, "_plan.json", { items: [{ stage: "tts", scene: 1, costUsd: 0.02 }], totalUsd: 0.02 });
    expect(await cliJson(["plan", "x", "--json"])).toEqual({ items: [{ stage: "tts", scene: 1, costUsd: 0.02 }], totalUsd: 0.02 });
    process.env.FLOWCHAIN_CLI = join(studio.root, "missing.mjs");
    await expect(cliJson(["plan", "x", "--json"])).rejects.toMatchObject({ code: "validation" });
  });
});
