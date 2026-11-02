import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The scene-sound worker (Foley) was removed on 2026-11-02 (phase 15 spec §13.12; its code is at the tag `foley-last`). What
 * is left of it in the code is what an old run needs to load and re-render: its sound model id parsed as retired, the
 * settings and prices an older `.env` and `prices.json` carry still accepted, the manifest's comments on what such a run
 * holds, and the list of names no customer-facing surface may carry. Nothing else names it, and no code makes a run with it.
 */
const ALLOWED = [
  "src/config.ts", // RUNPOD_FOLEY_ENDPOINT and the three runpodFoley* prices: still accepted, read by nothing
  "src/manifest/schema.ts", // what an old run's `models.sound` and a bought `scenes[i].sound` were
  "src/providers/model-id.ts", // `sound-foley` parsed as retired
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

const code = () => ["src", "web", "scripts"].flatMap(files);

describe("what is left of Foley in the code", () => {
  it("is named only in the files an old run needs and the list of names no page may show", () => {
    const naming = code()
      .filter((path) => /foley/i.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path))
      .sort();
    expect(naming).toEqual([...ALLOWED].sort());
  });

  it("never makes a new run with scene sound: nothing sets it, and no code reads the removed worker's switch or endpoint", () => {
    const offenders = code()
      .filter((path) => path !== join("src", "config.ts"))
      // (a run's status copies the field from a run that has it: `r.sceneSound ? { sceneSound: true } : {}` sets nothing)
      .filter((path) => /(?<!\.sceneSound \? \{ )sceneSound: true|\.sceneSound\s*=(?!=)|FLOWCHAIN_SCENE_SOUND|RUNPOD_FOLEY_ENDPOINT/.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path));
    expect(offenders).toEqual([]);
  });

  it("has no worker folder, image job or test command of its own any more", () => {
    expect(() => statSync("worker-foley")).toThrow();
    expect(readFileSync(".github/workflows/worker-image.yml", "utf8")).not.toMatch(/^\s+foley:|context: worker-foley|"worker-foley\/\*\*"/m);
    expect(readFileSync("package.json", "utf8")).not.toMatch(/foley/i);
  });
});
