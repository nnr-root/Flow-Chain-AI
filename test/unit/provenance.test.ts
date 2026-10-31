import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 15 spec §9.4: the LTX licence requires a clip's provenance, watermark and metadata to be kept, never removed or
// weakened. Every ffmpeg step that reads a clip or makes something from it lives in these folders; none may drop or
// rewrite metadata.

const ROOTS = ["src/media", "src/stages"];

/** The flags that drop or rewrite what a file carries: `-map_metadata -1`, `-fflags +bitexact`, `-metadata k=v`. */
const STRIPPING: RegExp[] = [/map_metadata/, /-fflags/, /bitexact/, /["'`]-metadata["'`]/, /-metadata(?::[sgcp])?\s/];

/**
 * Uses that are allowed on purpose, by file (relative to the repository) and the line's text. None today: a use added
 * here must say why it never touches a clip or anything made from one.
 */
const ALLOWED: Record<string, string[]> = {};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

function strippingUses(file: string, text: string): string[] {
  return text
    .split("\n")
    .map((line, n) => ({ line: line.trim(), n: n + 1 }))
    .filter(({ line }) => STRIPPING.some((p) => p.test(line)))
    .filter(({ line }) => !(ALLOWED[file] ?? []).includes(line))
    .map(({ line, n }) => `${file}:${n}: ${line}`);
}

describe("what a clip carries", () => {
  it("is never stripped by an ffmpeg step of the media helpers or the stages", () => {
    const found = ROOTS.flatMap((root) => sources(root)).flatMap((f) => strippingUses(relative(process.cwd(), f), readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });

  it("would be caught if a step dropped the metadata or made the output bit-exact", () => {
    for (const line of [
      'await ffmpeg(["-i", clip, "-map_metadata", "-1", out]);',
      'const args = ["-fflags", "+bitexact", "-i", clip];',
      'args.push("-flags:a", "+bitexact");',
      'await ffmpeg(["-i", clip, "-metadata", "comment=", out]);',
    ]) {
      expect(strippingUses("src/media/x.ts", line)).toHaveLength(1);
    }
    expect(strippingUses("src/media/x.ts", 'await ffmpeg(["-i", clip, "-vn", "-map", "0:a:0", out]);')).toEqual([]);
  });
});
