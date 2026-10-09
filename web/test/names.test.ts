import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINES, INTERNAL_NAMES, namesInternals, NOT_READY, publicLog } from "@/lib/engines";
import { forCustomers, studioHealth, studioHealthRaw } from "@/server/jobs";
import { useStudio } from "./helpers";

/*
 * Phase 5 spec §7: nothing a customer is sent names a model, the company behind one, or a setting that holds a
 * key. The first two tests read what is shipped — the published showcase files and the source of everything a
 * browser can be sent — so a name typed into a page later fails here, not in front of a customer.
 */
const web = join(import.meta.dirname, "..");
const files = (dir: string, keep: (path: string) => boolean): string[] =>
  readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(f).isFile() && keep(f));

/** A source file as far as it can reach a browser: without comments, and without the lines that only import. */
const shipped = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(?<![:"'`])\/\/[^\n]*/g, "")
    .replace(/^\s*(import|export)\b[^\n]*\bfrom\s+["'][^"']+["'];?\s*$/gm, "");

describe("what a customer is sent names no model, no provider and no key", () => {
  it("in the published showcase files", () => {
    const published = files(join(web, "public/showcase"), (f) => /\.(json|txt|md|html|svg)$/.test(f));
    expect(published.length).toBeGreaterThan(8);
    for (const file of published) {
      const hit = INTERNAL_NAMES.find((name) => name.test(readFileSync(file, "utf8")));
      expect(hit, `${file} matches ${hit}`).toBeUndefined();
    }
  });

  it("in the source of the pages, the components and the code they share", () => {
    // (not held to it: the list of names itself)
    const exempt = ["lib/engines.ts"].map((f) => join(web, f));
    const sources = ["app", "components", "lib"].flatMap((dir) => files(join(web, dir), (f) => /\.(ts|tsx)$/.test(f) && !exempt.includes(f)));
    expect(sources.length).toBeGreaterThan(60);
    const hits = sources.flatMap((file) =>
      shipped(readFileSync(file, "utf8")).split("\n").filter(namesInternals).map((line) => `${file.slice(web.length + 1)}: ${line.trim().slice(0, 120)}`));
    expect(hits).toEqual([]);
  });

  it("the check itself can fail: it finds a name in page text, and not in a comment or an import", () => {
    expect(shipped('<p>Voices by ElevenLabs</p>').split("\n").some(namesInternals)).toBe(true);
    expect(shipped('const hint = "Empty = GEMINI_API_KEY from .env";').split("\n").some(namesInternals)).toBe(true);
    expect(shipped('// RunPod bills by the second\nimport { x } from "@/lib/accounts";\n/* Wan 2.2 */ const a = 1;').split("\n").some(namesInternals)).toBe(false);
    // the names customers are given are not internal names, and neither is where they pay
    for (const said of [...Object.values(ENGINES), "Paid on Stripe's pages", "Flow Chain", "Runway", "a falling leaf", "Run a pod of dolphins"]) expect(namesInternals(said), said).toBe(false);
  });
});

describe("a job's output as a customer may read it", () => {
  it("keeps the pipeline's own words and replaces every line that says how the studio is built", () => {
    const log = publicLog([
      "Run 20261009-101010-abc123 → runs/20261009-101010-abc123",
      "✓ script — done ($0.0055)",
      "ElevenLabs voice 21m00Tcm4TlvDq8ikWAM: HTTP 401 invalid_api_key",
      "RunPod job 7f3a on endpoint ab12cd34: FAILED (CUDA out of memory)",
      "this run's clips came from fal-ai/kling-video, a hosted model",
      "Resume with: npm run flowchain -- resume 20261009-101010-abc123",
    ]);
    expect(log[0]).toContain("Run 20261009-101010-abc123");
    expect(log[1]).toBe("✓ script — done ($0.0055)");
    // three lines in a row said how it is built: one line stands for them, and none of their words is left
    expect(log).toHaveLength(4);
    expect(log[2]).toMatch(/details are kept with the studio/);
    expect(log.some(namesInternals)).toBe(false);
    expect(log.join("\n")).not.toMatch(/21m00|ab12cd34|401|CUDA/);
  });
});

describe("where a job's output is read for showing", () => {
  it("no page and no route reads the raw output: each goes through the function that knows who is looking", () => {
    const readers = files(join(web, "app"), (f) => /\.(ts|tsx)$/.test(f)).filter((f) => /\blogTail\b/.test(readFileSync(f, "utf8")));
    expect(readers.map((f) => f.slice(web.length + 1))).toEqual([]);
    expect(files(join(web, "app"), (f) => /\.(ts|tsx)$/.test(f)).some((f) => /\bshownLog\b/.test(readFileSync(f, "utf8")))).toBe(true);
  });
});

describe("the studio's readiness", () => {
  const studio = useStudio();

  it("names the missing settings to the owner of a studio without accounts, and to nobody in a studio with them", async () => {
    void studio;
    const raw = await studioHealthRaw();
    expect(raw.missing).toContain("GEMINI_API_KEY");
    // the owner's own studio: the names, as they are
    expect((await studioHealth()).missing).toEqual(raw.missing);
    // a studio with accounts: that something is missing, and not what
    expect(forCustomers(raw, true).missing).toEqual([NOT_READY]);
    expect(JSON.stringify(forCustomers(raw, true))).not.toMatch(/API_KEY|ENDPOINT|R2_/);
    // and a studio that lacks nothing says so either way
    expect(forCustomers({ ...raw, missing: [] }, true).missing).toEqual([]);
  });
});
