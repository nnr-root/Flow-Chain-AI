import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wan was removed on 2026-11-02 (phase 15 spec §13.10; its code is at the tag `wan-last`). What is left of it in the code is
 * what an old run needs to load and re-render: its profiles' clip lengths and the enum that names them, and its clip
 * model id parsed as retired. And the list of names no customer-facing surface may carry. Nothing else names it.
 */
const ALLOWED = [
  "src/video-profiles.ts", // the Wan profiles (clip lengths an old run's keys hold, a refusing price) and the `VideoProfileId` enum
  "src/providers/model-id.ts", // `clip-wan22-*` parsed as retired
  "web/lib/engines.ts", // INTERNAL_NAMES: a name no page may show
];

const SKIP = new Set(["node_modules", ".next", ".e2e", "test", "test-results", "e2e", "accounts", "stack"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP.has(name) ? [] : files(path);
    return /\.(ts|tsx|mts|mjs|js|json|sql|css)$/.test(name) ? [path] : [];
  });
}

describe("what is left of Wan in the code", () => {
  it("is named only in the files an old run needs and the list of names no page may show", () => {
    const naming = ["src", "web", "scripts"]
      .flatMap(files)
      .filter((path) => /wan22|clip-wan/i.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path))
      .sort();
    expect(naming).toEqual([...ALLOWED].sort());
  });

  it("has no clip worker folder of its own any more", () => {
    expect(() => statSync("workers")).toThrow();
  });
});
