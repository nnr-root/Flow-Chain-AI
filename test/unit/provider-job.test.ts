import { describe, expect, it } from "vitest";
import { UnusableResultError } from "../../src/providers/retry.js";
import { runProviderJob, type JobSpec } from "../../src/stages/job.js";
import type { RunContext } from "../../src/stages/types.js";
import { loadManifest } from "../../src/manifest/store.js";
import { makeTestContext } from "../helpers/context.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runContext() {
  const { ctx } = await makeTestContext({ modes: [1] });
  const charges: number[] = [];
  const run: RunContext = { ...ctx, inputHash: "h1", charge: async (usd) => void charges.push(usd) };
  return { run, charges };
}

/** A submit that, like a real HTTP request, completes after `ms` unless its signal aborts it first. */
function slowSubmit(ms: number, bought: string[]) {
  return (_job: unknown, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => {
        bought.push("req-late");
        resolve("req-late");
      }, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(signal.reason);
      });
    });
}

function spec(
  overrides: Partial<JobSpec<{ url: string; costUsd?: number }>>,
): JobSpec<{ url: string; costUsd?: number }> {
  return {
    label: "clip scene 1",
    costUsd: 0.25,
    prepare: async () => ({ input: {} }),
    submit: async () => "req-1",
    wait: async () => ({ url: "file:///clip.mp4" }),
    waitMs: 1000,
    submitTimeoutMs: 50,
    ...overrides,
  };
}

describe("runProviderJob submit deadline", () => {
  it("runs free preparation (seam render, upload) before the submit clock starts", async () => {
    const { run, charges } = await runContext();
    let prepared = false;
    const result = await runProviderJob(
      run,
      0,
      "clips",
      spec({
        prepare: async () => {
          await sleep(120); // longer than the 50 ms submit deadline
          prepared = true;
          return { input: { image_url: "https://fal.media/up.png" } };
        },
        submit: async (job) => {
          expect(prepared).toBe(true);
          expect(job.input).toEqual({ image_url: "https://fal.media/up.png" });
          return "req-1";
        },
      }),
    );
    expect(result).toEqual({ url: "file:///clip.mp4" });
    expect(run.manifest.scenes[0].jobs.clips?.requestId).toBe("req-1");
    expect(charges).toEqual([0.25]);
  });

  it("cancels a submit that outlives its deadline, so nothing is bought later or recorded", async () => {
    const { run, charges } = await runContext();
    const bought: string[] = [];
    let signal: AbortSignal | undefined;
    const slow = slowSubmit(150, bought);
    const err = await runProviderJob(
      run,
      0,
      "clips",
      spec({
        submit: (job, s) => {
          signal = s;
          return slow(job, s);
        },
      }),
    ).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/clip scene 1: submit timed out after 50 ms and was cancelled/);
    expect(signal?.aborted).toBe(true);
    expect(run.manifest.scenes[0].jobs.clips).toBeUndefined();
    await sleep(200); // past the moment the abandoned request would have completed
    expect(bought).toEqual([]);
    expect(charges).toEqual([]);

    // the next attempt (e.g. resume) submits exactly one new job
    let submits = 0;
    await runProviderJob(run, 0, "clips", spec({ submit: async () => `req-${++submits}` }));
    expect(submits).toBe(1);
    expect(run.manifest.scenes[0].jobs.clips?.requestId).toBe("req-1");
    expect(charges).toEqual([0.25]);
  });

  it("a submit that fails outright is not retried and records nothing", async () => {
    const { run } = await runContext();
    let submits = 0;
    const err = await runProviderJob(
      run,
      0,
      "clips",
      spec({
        submit: async () => {
          submits++;
          throw new Error("fal 503");
        },
      }),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/fal 503/);
    expect(submits).toBe(1);
    expect(run.manifest.scenes[0].jobs.clips).toBeUndefined();
  });
});

describe("runProviderJob charges", () => {
  it("charges the provider's measured cost when it reports one, else the estimate", async () => {
    const measured = await runContext();
    await runProviderJob(measured.run, 0, "clips", spec({ wait: async () => ({ url: "file:///c.mp4", costUsd: 0.0731 }) }));
    expect(measured.charges).toEqual([0.0731]);
    const estimated = await runContext();
    await runProviderJob(estimated.run, 0, "clips", spec({}));
    expect(estimated.charges).toEqual([0.25]);
  });

  it("charges a billed but unusable job what the provider says it cost", async () => {
    const { run, charges } = await runContext();
    const failed = spec({
      wait: async () => {
        throw new UnusableResultError("RunPod job job-1 failed", 0.0123);
      },
    });
    await expect(runProviderJob(run, 0, "clips", failed)).rejects.toThrow(/request req-1 is kept/);
    expect(charges).toEqual([0.0123]);
  });

  it("charges nothing for a failed job that never ran, still marks it unusable and saves the manifest", async () => {
    const { run, charges } = await runContext();
    let polls = 0;
    const neverRan = spec({
      wait: async () => {
        polls++;
        run.manifest.scenes[0].nonces.tts = 9; // in-memory change only a save can persist
        throw new UnusableResultError("RunPod job job-1 failed", 0);
      },
    });
    await expect(runProviderJob(run, 0, "clips", neverRan)).rejects.toThrow(/request req-1 is kept/);
    expect(polls).toBe(1); // unusable results are not retried
    expect(charges).toEqual([0]); // not the 0.25 estimate
    expect(run.manifest.scenes[0].jobs.clips).toMatchObject({ requestId: "req-1", chargedUsd: 0 });
    expect((await loadManifest(run.dir)).scenes[0].nonces.tts).toBe(9);
  });
});
