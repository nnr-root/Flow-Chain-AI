import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { maxJobs } from "@/server/config";
import {
  childEnv, clearStaleLock, cliJson, JOB_EXIT, JOB_FILE, JOB_LOG, liveJobs, logTail, readJob, runner, startJob, stopJob, studioHealth, viewJob,
} from "@/server/jobs";
import { calls, nextRunId, stub, until, useStudio } from "./helpers";

const studio = useStudio();
const ended = (dir: string) => until(() => (readJob(dir)?.state !== "running" ? readJob(dir) : null));

describe("the runner", () => {
  it("is the local one without a Redis address: the CLI is this server's own child and nothing is queued", async () => {
    expect(runner().mode).toBe("local");
    expect((await studioHealth()).queue).toEqual({ mode: "local" });
    const id = nextRunId();
    expect(await viewJob(id)).toBeNull();
    expect((await startJob(id, "generate", ["resume", id])).state).toBe("running");
    await until(async () => (await viewJob(id))?.state === "ended");
  });
});

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
        process.kill(job.pid!, 0);
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

  it("treats a lock without a readable pid as live: the CLI creates the file, then writes its pid", async () => {
    const id = nextRunId();
    const dir = join(studio.runs, id);
    await mkdir(dir, { recursive: true });
    for (const text of ["", "\n", "not a pid\n", "-5\n", "12.5\n"]) {
      await writeFile(join(dir, ".lock"), text);
      await expect(clearStaleLock(id)).rejects.toMatchObject({ code: "job_active" });
      expect(existsSync(join(dir, ".lock"))).toBe(true);
    }
  });

  it("an exit file read before its code is written does not count as an exit: the process decides", async () => {
    const id = nextRunId();
    const dir = join(studio.runs, id);
    await mkdir(dir, { recursive: true });
    const stored = { id: "j", kind: "generate", args: [], startedAt: "t" };
    for (const text of ["", "\n", "abc\n", "1.5\n"]) {
      await writeFile(join(dir, JOB_EXIT), text);
      await writeFile(join(dir, JOB_FILE), JSON.stringify({ ...stored, pid: process.pid }));
      expect(readJob(dir), JSON.stringify(text)).toMatchObject({ state: "running" });
      await writeFile(join(dir, JOB_FILE), JSON.stringify({ ...stored, pid: 2 ** 22 + 12345 }));
      expect(readJob(dir), JSON.stringify(text)).toMatchObject({ state: "interrupted" });
    }
    await writeFile(join(dir, JOB_EXIT), "137\n");
    expect(readJob(dir)).toMatchObject({ state: "ended", exitCode: 137 });
    await writeFile(join(dir, JOB_EXIT), "0\n");
    expect(readJob(dir)).toMatchObject({ state: "ended", exitCode: 0 });
  });

  it("gives the CLI the studio's environment without Next's own variables", () => {
    const names = ["NODE_ENV", "NODE_OPTIONS", "NEXT_RUNTIME", "NEXT_PRIVATE_WORKER", "__NEXT_PRIVATE_ORIGIN", "__NEXT_PROCESSED_ENV", "NEXTAUTH_URL", "FAL_KEY", "PORT"];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    try {
      for (const n of names) process.env[n] = "x";
      const env = childEnv();
      for (const n of ["NODE_ENV", "NODE_OPTIONS", "NEXT_RUNTIME", "NEXT_PRIVATE_WORKER", "__NEXT_PRIVATE_ORIGIN", "__NEXT_PROCESSED_ENV"]) {
        expect(env, n).not.toHaveProperty(n);
      }
      // everything else passes through, also names that merely start like Next's
      expect(env).toMatchObject({ NEXTAUTH_URL: "x", FAL_KEY: "x", PORT: "x", PATH: process.env.PATH, RUNS_DIR: studio.runs, FLOWCHAIN_ROOT: studio.root });
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  });

  it("the machine limit falls back to 2 unless STUDIO_MAX_JOBS is a whole number of at least 1", () => {
    delete process.env.STUDIO_MAX_JOBS;
    expect(maxJobs()).toBe(2);
    for (const bad of ["", " ", "0", "-1", "1.5", "two", "NaN", "Infinity", "3 jobs"]) {
      process.env.STUDIO_MAX_JOBS = bad;
      expect(maxJobs(), JSON.stringify(bad)).toBe(2);
    }
    for (const [raw, n] of [["1", 1], ["3", 3], [" 4 ", 4]] as const) {
      process.env.STUDIO_MAX_JOBS = raw;
      expect(maxJobs()).toBe(n);
    }
  });

  it("reads a process's start time the same way in any locale", async () => {
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    await stub(studio, "_behave.json", { sleepMs: 3000 });
    const id = nextRunId();
    try {
      Object.assign(process.env, { LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" });
      const job = await startJob(id, "generate", ["resume", id]);
      expect(job.procStart).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /);
      // a server restarted under another locale still recognises its job
      Object.assign(process.env, { LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" });
      expect(readJob(join(studio.runs, id))).toMatchObject({ state: "running" });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await stopJob(id).catch(() => undefined);
    }
  });

  it("two copies of the module (a dev-server recompile) share the starts in flight: one run still starts once", async () => {
    await stub(studio, "_behave.json", { sleepMs: 3000 });
    const first = await import("@/server/jobs");
    vi.resetModules();
    const second = await import("@/server/jobs");
    expect(second.startJob).not.toBe(first.startJob);
    const id = nextRunId();
    const results = await Promise.allSettled([first.startJob(id, "generate", ["resume", id]), second.startJob(id, "generate", ["resume", id])]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "job_active" });
    await until(async () => (await calls(studio)).length >= 1);
    await new Promise((r) => setTimeout(r, 300)); // a second CLI would have logged its call by now
    expect(await calls(studio)).toHaveLength(1);
    await stopJob(id);
  });

  it("cliJson returns a free command's JSON and turns a failure into a readable error", async () => {
    await stub(studio, "_plan.json", { items: [{ stage: "tts", scene: 1, costUsd: 0.02 }], totalUsd: 0.02 });
    expect(await cliJson(["plan", "x", "--json"])).toEqual({ items: [{ stage: "tts", scene: 1, costUsd: 0.02 }], totalUsd: 0.02 });
    process.env.FLOWCHAIN_CLI = join(studio.root, "missing.mjs");
    await expect(cliJson(["plan", "x", "--json"])).rejects.toMatchObject({ code: "validation" });
  });

  it("two starts of one run fired together: one wins, the other is refused, and the CLI runs once", async () => {
    await stub(studio, "_behave.json", { sleepMs: 3000 });
    const id = nextRunId();
    const results = await Promise.allSettled([startJob(id, "generate", ["resume", id]), startJob(id, "generate", ["resume", id])]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "job_active" });
    await until(async () => (await calls(studio)).length >= 1);
    await new Promise((r) => setTimeout(r, 300)); // a second CLI would have logged its call by now
    expect(await calls(studio)).toHaveLength(1);
    await stopJob(id);
  });

  it("two different runs started together against a limit of one: one wins, the other is busy", async () => {
    process.env.STUDIO_MAX_JOBS = "1";
    await stub(studio, "_behave.json", { sleepMs: 3000 });
    const a = nextRunId();
    const b = nextRunId();
    const results = await Promise.allSettled([startJob(a, "generate", ["resume", a]), startJob(b, "generate", ["resume", b])]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "busy" });
    await stopJob(results[0].status === "fulfilled" ? a : b);
  });

  it("a recorded pid that now belongs to another process is not the job: interrupted, and Stop leaves it alone", async () => {
    const id = nextRunId();
    const dir = join(studio.runs, id);
    await mkdir(dir, { recursive: true });
    const stored = { id: "j", kind: "generate", args: [], pid: process.pid, startedAt: "t" };
    await writeFile(join(dir, JOB_FILE), JSON.stringify({ ...stored, procStart: "Thu Jan  1 00:00:00 1970" }));
    expect(readJob(dir)).toMatchObject({ state: "interrupted" });
    await expect(stopJob(id)).rejects.toMatchObject({ code: "not_found" });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    // without a recorded start time the pid alone decides (job files written by hand)
    await writeFile(join(dir, JOB_FILE), JSON.stringify(stored));
    expect(readJob(dir)).toMatchObject({ state: "running" });
  });

  it("a job records its process's start time, and is running while that still matches", async () => {
    await stub(studio, "_behave.json", { sleepMs: 3000 });
    const id = nextRunId();
    const job = await startJob(id, "generate", ["resume", id]);
    expect(job.procStart).toEqual(expect.any(String));
    expect(JSON.parse(await readFile(join(studio.runs, id, JOB_FILE), "utf8")).procStart).toBe(job.procStart);
    expect(readJob(join(studio.runs, id))).toMatchObject({ state: "running" });
    await stopJob(id);
  });

  it("a run id that is not a run id is refused by every function that touches the runs folder", async () => {
    const outside = join(studio.root, "x");
    for (const call of [
      () => startJob("../x", "generate", ["resume", "../x"]),
      () => stopJob("../x"),
      () => clearStaleLock("../x"),
      () => logTail("../x"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "not_found" });
    }
    expect(existsSync(outside)).toBe(false);
    expect(await calls(studio)).toEqual([]);
  });
});
