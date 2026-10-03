import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_FILE, withRunLock } from "../../src/manifest/store.js";

describe("withRunLock", () => {
  it("holds <runDir>/.lock while the work runs and removes it afterwards", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-lock-"));
    const seen = await withRunLock(dir, async () => existsSync(join(dir, LOCK_FILE)));
    expect(seen).toBe(true);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it("refuses a second concurrent run of the same run dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-lock-"));
    let inner: unknown;
    await withRunLock(dir, async () => {
      inner = await withRunLock(dir, async () => "ran").catch((e: unknown) => e);
    });
    expect((inner as Error).message).toMatch(/already in progress/);
    expect((inner as Error).message).toContain(join(dir, LOCK_FILE));
  });

  it("releases the lock when the work throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-lock-"));
    await expect(withRunLock(dir, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    expect(await withRunLock(dir, async () => "again")).toBe("again");
  });
});
