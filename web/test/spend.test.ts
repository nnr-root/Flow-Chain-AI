import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spendOf } from "@/worker/tenant";

async function run(manifest: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fc-spend-"));
  if (manifest !== undefined) await writeFile(join(dir, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return dir;
}

describe("what a run has spent, from its manifest", () => {
  it("is the ledger's sum, to four decimals", async () => {
    expect(spendOf(await run({ ledger: [{ usd: 0.0055 }, { usd: 0.1 }, { usd: 0.2 }], scenes: [] }))).toBe(0.3055);
    expect(spendOf(await run({ ledger: [] }))).toBe(0);
  });

  it("counts a provider job that was submitted and not collected: the provider bills it either way", async () => {
    const jobs = {
      // submitted, the run was stopped before its result came
      clips: { requestId: "r1", inputHash: "h", submittedAt: "t", expectedUsd: 0.25, chargedUsd: 0 },
      // collected: its cost is in the ledger already
      keyframe: { requestId: "r2", inputHash: "h", submittedAt: "t", expectedUsd: 0.025, chargedUsd: 0.025, result: { url: "u" } },
    };
    expect(spendOf(await run({ ledger: [{ usd: 0.025 }], scenes: [{ jobs }, { jobs: {} }, {}] }))).toBe(0.275);
    // a run made before expected costs were recorded: only what the ledger says
    expect(spendOf(await run({ ledger: [{ usd: 0.025 }], scenes: [{ jobs: { clips: { requestId: "r1", inputHash: "h", submittedAt: "t", chargedUsd: 0 } } }] }))).toBe(0.025);
  });

  it("says so when it cannot say: no manifest is not the same as a manifest that cannot be read", async () => {
    expect(spendOf(await run(undefined))).toBeNull();
    expect(spendOf(await run("{ half a file"))).toBeUndefined();
    expect(spendOf(await run({ ledger: [{ usd: "0.1" }] }))).toBeUndefined();
    expect(spendOf(await run({ ledger: [{ usd: -1 }] }))).toBeUndefined();
    expect(spendOf(await run({ ledger: [], scenes: [{ jobs: { clips: { expectedUsd: "lots", chargedUsd: 0 } } }] }))).toBeUndefined();
  });
});
