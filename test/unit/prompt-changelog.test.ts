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
  it("has each version from .1 to the current one exactly once, the date being the day each was made", () => {
    const counter = Number(PROMPT_VERSION.slice(11));
    expect(entries.map((e) => Number(e.slice(11)))).toEqual(Array.from({ length: counter }, (_, i) => i + 1));
    expect(entries.at(-1)).toBe(PROMPT_VERSION);
  });
});
