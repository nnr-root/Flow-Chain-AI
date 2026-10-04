import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { createManifest } from "../../src/manifest/store.js";
import { computeHash } from "../../src/pipeline.js";
import { captionsStage } from "../../src/stages/captions.js";
import { clipsStage } from "../../src/stages/clips.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { scriptStage } from "../../src/stages/script.js";
import type { StageContext } from "../../src/stages/types.js";
import { tempDir } from "../helpers/media.js";

/**
 * A run scripted before 2.2: explicit modes and render options, no style, no 2.2 script fields. The expected
 * hashes were computed by the 2.1 code (commit edf9f80); if they change, every existing run would re-buy its
 * script, keyframes and clips on resume or rerender.
 */
async function oldRun(): Promise<StageContext> {
  const dir = await tempDir("flowchain-compat-");
  await mkdir(join(dir, "images"));
  await writeFile(join(dir, "images/keyframe_01.png"), "keyframe bytes");
  const manifest = createManifest(
    "old-run",
    {
      topic: "foxes",
      aspect: "9:16",
      sceneCount: 2,
      modes: [1, 1],
      voiceId: "v",
      render: { captionStyle: "hormozi", transition: "fade", bgmGain: 0.35 },
    },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );
  manifest.script = {
    title: "Old run",
    styleBible: { artStyle: "oil painting", characters: "a red fox", palette: "teal, orange" },
    scenes: [1, 2].map((n) => ({
      narration: `Scene ${n} says hello.`,
      imagePrompt: `image ${n}`,
      motionPrompt: `motion ${n}`,
      shot: n === 1 ? ("cut" as const) : ("continue" as const),
      camera: "zoom_in" as const,
    })),
  };
  manifest.scenes.forEach((s, i) => {
    s.audio = { path: `audio/scene_0${i + 1}.wav`, duration: 2, removedSec: 0, words: [{ text: "hello", start: 0.1, end: 0.5 }] };
  });
  return {
    dir,
    manifest,
    providers: undefined as never,
    prices: Prices.parse({}),
    size: { width: 1080, height: 1920 },
    keyframeSize: { width: 1088, height: 1920 },
    fps: 30,
    fontsDir: "assets/fonts",
    retryDelayMs: 0,
    log: () => {},
  };
}

describe("runs made before 2.2", () => {
  it("keep the cache keys of their paid and free work", async () => {
    const ctx = await oldRun();
    expect({
      script: await computeHash(ctx, scriptStage),
      keyframes: await computeHash(ctx, keyframesStage, 0),
      clips: await computeHash(ctx, clipsStage, 0),
      captions: await computeHash(ctx, captionsStage),
    }).toEqual({
      script: "b351a1be896b9a3c5eca59e155ac545cec31f368d36c1b512832835477e0001b",
      keyframes: "e7279f635c89f0f0d89b6273fa38e34afef16501ab415cb7d40df7dffd6eefe8",
      clips: "c1a77b1729a9d8dc526ecb84a387167fc06899bc08364a737e12c105c0adb329",
      captions: "3f988fe9b865207dd8378d2da4cdc66cc75109d5bc8ad6a9ba2c56e28c58ad3b",
    });
  });
});
