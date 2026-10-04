import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cellSize, contactSheet } from "../../src/media/contact-sheet.js";
import { probeVideo } from "../../src/media/ffmpeg.js";
import { extractFrame, extractLastFrame } from "../../src/media/frames.js";
import { frameDiff, makeImage, makeVideo, tempDir } from "../helpers/media.js";

describe("extractLastFrame", () => {
  it("returns the true final frame", async () => {
    const dir = await tempDir();
    const v = join(dir, "v.mp4");
    await makeVideo(v, { seconds: 2, fps: 30 });
    await extractLastFrame(v, join(dir, "last.png"));
    await extractFrame(v, 59, join(dir, "ref.png"));
    await extractFrame(v, 0, join(dir, "first.png"));
    expect(await frameDiff(join(dir, "last.png"), join(dir, "ref.png"))).toBe(0);
    expect(await frameDiff(join(dir, "last.png"), join(dir, "first.png"))).toBeGreaterThan(0);
  });

  it("works on clips shorter than one second", async () => {
    const dir = await tempDir();
    const v = join(dir, "short.mp4");
    await makeVideo(v, { frames: 12, fps: 30 });
    await extractLastFrame(v, join(dir, "last.png"));
    await extractFrame(v, 11, join(dir, "ref.png"));
    expect(await frameDiff(join(dir, "last.png"), join(dir, "ref.png"))).toBe(0);
  });
});

describe("contactSheet", () => {
  it("lays out first/last pairs as rows", async () => {
    const dir = await tempDir();
    const rows = [];
    for (const n of [1, 2]) {
      const first = join(dir, `f${n}.png`);
      const last = join(dir, `l${n}.png`);
      await makeImage(first, { width: 180, height: 320, color: "red" });
      await makeImage(last, { width: 180, height: 320, color: "blue" });
      rows.push({ first, last });
    }
    const cell = cellSize({ width: 180, height: 320 });
    const out = join(dir, "chain.png");
    await contactSheet(rows, out, cell);
    const { width, height } = await probeVideo(out);
    expect({ width, height }).toEqual({ width: cell.width * 2, height: cell.height * 2 });
  });
});
