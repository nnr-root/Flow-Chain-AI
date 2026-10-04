import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { download } from "../../src/providers/download.js";
import { HttpError, NonRetryableError, withRetry } from "../../src/providers/retry.js";

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

  it("does not retry client errors or errors marked non-retryable, and keeps the cause", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      let n = 0;
      const original = new HttpError(`HTTP ${status}`, status);
      const err = await withRetry("tts scene 1", async () => {
        n++;
        throw original;
      }, { timeoutMs: 1000, sleep: noSleep }).catch((e: unknown) => e);
      expect(n).toBe(1);
      expect((err as Error).message).toBe(`tts scene 1 failed after 1 attempt: HTTP ${status}`);
      expect((err as Error).cause).toBe(original);
    }
    let n = 0;
    await expect(
      withRetry("x", async () => {
        n++;
        throw new NonRetryableError("flagged");
      }, { timeoutMs: 1000, sleep: noSleep }),
    ).rejects.toThrow("x failed after 1 attempt: flagged");
    expect(n).toBe(1);
  });

  it("does not retry quota or rate-limit errors (429), including Gemini's own ApiError", async () => {
    let n = 0;
    const quota = new ApiError({ message: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', status: 429 });
    const err = await withRetry("script generation", async () => {
      n++;
      throw quota;
    }, { timeoutMs: 1000, sleep: noSleep }).catch((e: unknown) => e);
    expect(n).toBe(1); // one request, so a daily quota is not burned three times per attempt
    expect((err as Error).message).toMatch(/^script generation failed after 1 attempt: /);
    expect((err as Error).cause).toBe(quota);

    n = 0;
    await withRetry("tts scene 1", async () => {
      n++;
      throw new HttpError("HTTP 429", 429);
    }, { timeoutMs: 1000, sleep: noSleep }).catch(() => {});
    expect(n).toBe(1);
  });

  it("retries server errors", async () => {
    let n = 0;
    await expect(
      withRetry("x", async () => {
        n++;
        throw new HttpError("HTTP 503", 503);
      }, { timeoutMs: 1000, sleep: noSleep }),
    ).rejects.toThrow("x failed after 3 attempts: HTTP 503");
    expect(n).toBe(3);
  });

  it("times out calls that never settle", async () => {
    await expect(
      withRetry("video", () => new Promise<never>(() => {}), { timeoutMs: 20, attempts: 2, sleep: noSleep }),
    ).rejects.toThrow(/video failed after 2 attempts: timed out after 20 ms/);
  });
});

describe("download", () => {
  it("gives up on a server that never answers", async () => {
    const server = createServer(() => {}); // accepts the request, never responds
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    try {
      await expect(download(`http://127.0.0.1:${port}/x.mp4`, join(dir, "x.mp4"), { timeoutMs: 100 })).rejects.toThrow(
        /download of http:\/\/127\.0\.0\.1:\d+\/x\.mp4 failed: .*timed out after 100 ms/,
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("copies file:// URLs into nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    const src = join(dir, "src.bin");
    await writeFile(src, "data");
    const dest = join(dir, "a", "b", "out.bin");
    await download(pathToFileURL(src).href, dest);
    expect(await readFile(dest, "utf8")).toBe("data");
  });
});
