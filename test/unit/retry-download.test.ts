import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { download } from "../../src/providers/download.js";
import { withRetry } from "../../src/providers/retry.js";

const noSleep = async () => {};

describe("withRetry", () => {
  it("retries with exponential backoff and returns the first success", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const result = await withRetry(
      "x",
      async () => {
        if (++n < 3) throw new Error("boom");
        return 42;
      },
      { timeoutMs: 1000, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe(42);
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("reports the label and last error after the final attempt", async () => {
    await expect(
      withRetry("tts scene 1", async () => Promise.reject(new Error("nope")), { timeoutMs: 1000, sleep: noSleep }),
    ).rejects.toThrow("tts scene 1 failed after 3 attempts: nope");
  });

  it("times out calls that never settle", async () => {
    await expect(
      withRetry("video", () => new Promise<never>(() => {}), { timeoutMs: 20, attempts: 2, sleep: noSleep }),
    ).rejects.toThrow(/video failed after 2 attempts: timed out after 20 ms/);
  });
});

describe("download", () => {
  it("copies file:// URLs into nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    const src = join(dir, "src.bin");
    await writeFile(src, "data");
    const dest = join(dir, "a", "b", "out.bin");
    await download(pathToFileURL(src).href, dest);
    expect(await readFile(dest, "utf8")).toBe("data");
  });
});
