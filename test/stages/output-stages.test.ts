import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { cellSize } from "../../src/media/contact-sheet.js";
import { countFrames, probeVideo, streamDuration } from "../../src/media/ffmpeg.js";
import { runPipeline, type RunOptions } from "../../src/pipeline.js";
import { globalWords } from "../../src/stages/captions.js";
import { STAGES } from "../../src/stages/index.js";
import { abs, paths } from "../../src/stages/paths.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("globalWords", () => {
  it("offsets each scene's words by the cumulative audio duration", () => {
    const m = createManifest(
      "r",
      { topic: "t", aspect: "9:16", sceneCount: 2, modes: [1, 1], voiceId: "v" },
      { llm: "l", tts: "t", image: "i", video: "v" },
    );
    m.scenes[0].audio = { path: "a", duration: 1.5, removedSec: 0, words: [{ text: "a", start: 0.1, end: 0.5 }] };
    m.scenes[1].audio = { path: "b", duration: 2, removedSec: 0, words: [{ text: "b", start: 0.2, end: 0.6 }] };
    expect(globalWords(m)).toEqual([
      { text: "a", start: 0.1, end: 0.5 },
      { text: "b", start: 1.7, end: 2.1 },
    ]);
  });
});

describe("full pipeline with fakes", () => {
  it("produces a frame-exact final.mp4, captions and chain.png", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 2] });
    await runPipeline(ctx, STAGES, auto);

    const total = ctx.manifest.scenes.reduce((a, s) => a + s.audio!.duration, 0);
    const frames = Math.round(total * 30);
    const final = abs(ctx, paths.final);
    expect(await countFrames(final)).toBe(frames);
    expect(await probeVideo(final)).toEqual({ width: 180, height: 320, fps: 30 });
    const drift = Math.abs((await streamDuration(final, "v")) - (await streamDuration(final, "a")));
    expect(drift).toBeLessThanOrEqual(1 / 30);
    expect(ctx.manifest.final?.duration).toBeCloseTo(frames / 30, 6);

    const ass = await readFile(abs(ctx, paths.captions), "utf8");
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:"))).toHaveLength(18);

    const cell = cellSize(ctx.size);
    const sheet = await probeVideo(abs(ctx, paths.chain));
    expect({ width: sheet.width, height: sheet.height }).toEqual({ width: cell.width * 2, height: cell.height * 2 });
  });
});
