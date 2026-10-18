import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "../../src/providers/prompt-version.js";

const spec = readFileSync(new URL("../../docs/superpowers/specs/2026-10-18-phase9-prompt-audit-design.md", import.meta.url), "utf8");
const changelog = spec.slice(spec.indexOf("## Changelog of `PROMPT_VERSION`"));
const entries = [...changelog.matchAll(/^- `(\d{4}-\d{2}-\d{2}\.\d+)` — /gm)].map((m) => m[1]);

describe("the prompt version's changelog in the spec", () => {
  it("has a line for the current version, so a bump without one is caught", () => {
    expect(entries).toContain(PROMPT_VERSION);
  });
  it("has each version from .1 to the current one exactly once", () => {
    const [date, counter] = [PROMPT_VERSION.slice(0, 10), Number(PROMPT_VERSION.slice(11))];
    const want = Array.from({ length: counter }, (_, i) => `${date}.${i + 1}`);
    expect(entries).toEqual(want);
  });
});
