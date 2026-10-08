import { describe, expect, it } from "vitest";
import { loadManifest, saveManifest } from "../../src/manifest/store.js";
import { withExpectedSpend } from "../../src/stages/inflight.js";
import type { RunContext } from "../../src/stages/types.js";
import { makeTestContext } from "../helpers/context.js";

async function runContext(): Promise<RunContext> {
  const { ctx } = await makeTestContext({ modes: [1] });
  return { ...ctx, inputHash: "h1", charge: async () => {} };
}

describe("a provider call that is paid for when it answers", () => {
  it("has its expected cost on record exactly while it is in flight", async () => {
    const run = await runContext();
    let during: Record<string, number> | undefined;
    const answer = await withExpectedSpend(run, "tts:0", 0.03, async () => {
      // what a process killed right now would leave behind
      during = (await loadManifest(run.dir)).inFlight;
      return "audio";
    });
    expect(answer).toBe("audio");
    expect(during).toEqual({ "tts:0": 0.03 });
    // Gone from memory, and from disk with the caller's next save — the one that writes the ledger entry — so no
    // state on disk has the call in neither place.
    expect(run.manifest.inFlight).toBeUndefined();
    expect((await loadManifest(run.dir)).inFlight).toEqual({ "tts:0": 0.03 });
    await saveManifest(run.dir, run.manifest);
    expect((await loadManifest(run.dir)).inFlight).toBeUndefined();
  });

  it("takes the entry away when the provider answers with an error: a refused request is not billed", async () => {
    const run = await runContext();
    await expect(withExpectedSpend(run, "script", 0.0055, async () => Promise.reject(new Error("503")))).rejects.toThrow("503");
    const saved = await loadManifest(run.dir);
    expect(saved.inFlight).toBeUndefined();
    expect(saved.abandonedUsd).toBeUndefined();
  });

  it("keeps the cost of a call whose process was ended before the answer, when the call is made again", async () => {
    const run = await runContext();
    // an earlier process got as far as sending the request
    run.manifest.inFlight = { "tts:0": 0.03, "tts:1": 0.02 };
    await withExpectedSpend(run, "tts:0", 0.03, async () => "audio");
    await saveManifest(run.dir, run.manifest);
    let saved = await loadManifest(run.dir);
    expect(saved.abandonedUsd).toBe(0.03);
    expect(saved.inFlight).toEqual({ "tts:1": 0.02 }); // the other scene's is still to be dealt with
    await withExpectedSpend(run, "tts:1", 0.02, async () => "audio");
    await saveManifest(run.dir, run.manifest);
    saved = await loadManifest(run.dir);
    expect(saved.abandonedUsd).toBe(0.05);
    expect(saved.inFlight).toBeUndefined();
  });
});
