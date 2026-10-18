import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "../../src/providers/prompt-version.js";
import { hashesOf, pinnedPrompts } from "../helpers/prompt-pins.js";

const FILE = new URL("./prompt-pins.json", import.meta.url);
type Pins = { version: string; hashes: Record<string, string> };
const now = (): Pins => ({ version: PROMPT_VERSION, hashes: hashesOf(pinnedPrompts()) });
const moved = (a: Record<string, string>, b: Record<string, string>): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((id) => a[id] !== b[id]);

/*
 * Phase 9 spec §4. Every prompt a model is given is pinned with the version it was written under, so a prompt edit
 * without a version bump cannot pass. To accept a change: bump PROMPT_VERSION (and add the changelog line to the
 * spec), then run UPDATE_PROMPT_PINS=1 npx vitest run test/unit/prompt-pin.test.ts
 */
if (process.env.UPDATE_PROMPT_PINS) {
  describe("updating the prompt pins", () => {
    it("refuses to accept changed prompts under an unchanged version", () => {
      let old: Pins | null = null;
      try {
        old = JSON.parse(readFileSync(FILE, "utf8")) as Pins;
      } catch {
        old = null;
      }
      const next = now();
      if (old && old.version === next.version && moved(old.hashes, next.hashes).length) {
        throw new Error(`prompts changed (${moved(old.hashes, next.hashes).join(", ")}) but PROMPT_VERSION is still ${old.version}: bump it first`);
      }
      writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
    });
  });
} else {
  describe("the prompts a model is given", () => {
    const pinned = JSON.parse(readFileSync(FILE, "utf8")) as Pins;

    it("are the ones pinned: a prompt edit without a version bump fails here", () => {
      const changed = moved(pinned.hashes, now().hashes);
      expect(changed, `prompts changed under version ${PROMPT_VERSION}; bump PROMPT_VERSION, then UPDATE_PROMPT_PINS=1`).toEqual([]);
    });

    it("are pinned under the version they are written for, so a bump without a pin update is caught", () => {
      expect(pinned.version).toBe(PROMPT_VERSION);
    });
  });
}
