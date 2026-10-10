import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { scriptCost } from "../../src/cost.js";
import {
  DEFAULT_SCENE_SECONDS, DEFAULT_VIDEO_SECONDS, expectedScenes, lengthInWords, parseDuration, parseSceneSeconds, SCENE_SECONDS, sceneBounds,
  sceneWords, scriptAnswerCost, scriptAnswers, scriptParts, timedScriptCost, totalWords, VIDEO_SECONDS, wordsTolerance,
} from "../../src/duration.js";
import { MAX_NARRATION_WORDS, MAX_SCENES } from "../../src/manifest/schema.js";
import { VIDEO_PROFILES } from "../../src/video-profiles.js";

const prices = Prices.parse({});

describe("a video asked for by its length", () => {
  it("can be from five seconds to ten minutes: the lengths of a short, then whole minutes", () => {
    expect([...VIDEO_SECONDS]).toEqual([5, 10, 15, 20, 30, 45, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600]);
    expect(VIDEO_SECONDS).toContain(DEFAULT_VIDEO_SECONDS);
    expect([lengthInWords(5), lengthInWords(45), lengthInWords(60), lengthInWords(600)]).toEqual(["5 seconds", "45 seconds", "1 minute", "10 minutes"]);
  });

  it("lets a scene stay no longer than a clip can be, and no shorter than the shortest one", () => {
    // the clip model's own limits, by way of the profile every new run is bought with
    const clip = VIDEO_PROFILES["wan22-480p@1"];
    expect(clip.clipSec(0.1)).toBeCloseTo(33 / 16, 5);
    expect(clip.clipSec(60)).toBeCloseTo(81 / 16, 5);
    expect(SCENE_SECONDS).toEqual({ min: Math.floor(clip.clipSec(0.1)), max: Math.floor(clip.clipSec(60)) });
    // a scene of the longest length, spoken a fifth too slowly, is still covered by one clip slowed a quarter
    expect(clip.clipSec(60) * 1.25).toBeGreaterThan(SCENE_SECONDS.max * 1.2);
    expect(DEFAULT_SCENE_SECONDS.min).toBeGreaterThanOrEqual(SCENE_SECONDS.min);
    expect(DEFAULT_SCENE_SECONDS.max).toBeLessThanOrEqual(SCENE_SECONDS.max);
  });

  it("works out how many scenes a length can be told in, and never more than a run can have", () => {
    expect(sceneBounds(30, { min: 3, max: 5 })).toEqual({ min: 6, max: 10 });
    expect(sceneBounds(30, { min: 5, max: 5 })).toEqual({ min: 6, max: 6 });
    expect(sceneBounds(5, { min: 3, max: 5 })).toEqual({ min: 1, max: 2 });
    expect(sceneBounds(5, { min: 5, max: 5 })).toEqual({ min: 1, max: 1 });
    expect(sceneBounds(600, { min: 2, max: 5 })).toEqual({ min: 120, max: 300 });
    expect(expectedScenes({ targetSec: 30, sceneSec: { min: 3, max: 5 } })).toBe(8);
    expect(expectedScenes({ targetSec: 5, sceneSec: { min: 2, max: 5 } })).toBe(1);
    // the longest video in the shortest scenes, with the fifth more that a script is allowed, still fits a run
    for (const sec of VIDEO_SECONDS) {
      const parts = scriptParts(sec) ?? [sec];
      const most = parts.reduce((sum, part) => sum + Math.ceil(sceneBounds(part, { min: 2, max: 2 }).max * 1.2), 0);
      expect(most, String(sec)).toBeLessThanOrEqual(MAX_SCENES);
    }
  });

  it("turns seconds into the words a script is asked for, by how fast the voice speaks", () => {
    expect(totalWords(30)).toBe(81);
    expect(sceneWords({ min: 3, max: 5 })).toEqual({ min: 8, max: 14 });
    // one exact length is given a word either way
    expect(sceneWords({ min: 5, max: 5 })).toEqual({ min: 12, max: 15 });
    expect(sceneWords({ min: 2, max: 2 })).toEqual({ min: 4, max: 7 });
    for (let min = SCENE_SECONDS.min; min <= SCENE_SECONDS.max; min++) {
      for (let max = min; max <= SCENE_SECONDS.max; max++) expect(sceneWords({ min, max }).max).toBeLessThanOrEqual(MAX_NARRATION_WORDS);
    }
    expect([wordsTolerance(14), wordsTolerance(81), wordsTolerance(162)]).toEqual([3, 13, 25]);
  });

  it("writes a video of up to a minute and a half in one answer, and a longer one in parts of about a minute", () => {
    for (const sec of [5, 30, 60]) expect(scriptParts(sec)).toBeNull();
    expect(scriptParts(120)).toEqual([60, 60]);
    expect(scriptParts(600)).toHaveLength(10);
    for (const sec of VIDEO_SECONDS) {
      const parts = scriptParts(sec);
      if (!parts) continue;
      expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(sec, 5);
      // no answer is asked for more scenes than a model keeps its rules over
      for (const part of parts) expect(sceneBounds(part, { min: 2, max: 2 }).max).toBeLessThanOrEqual(30);
    }
    expect(scriptAnswers({ targetSec: 30, sceneSec: { min: 3, max: 5 } })).toEqual([{ key: "script", scenes: 10 }]);
    expect(scriptAnswers({ targetSec: 120, sceneSec: { min: 3, max: 5 } })).toEqual([
      { key: "script:outline", scenes: 0 }, { key: "script:part:0", scenes: 20 }, { key: "script:part:1", scenes: 20 },
    ]);
  });

  it("prices a script by its answers: a short one at what a script has always cost, a long one by its scenes", () => {
    expect(scriptAnswerCost(prices, 0)).toBe(scriptCost(prices));
    expect(scriptAnswerCost(prices, 4)).toBe(scriptCost(prices));
    expect(scriptAnswerCost(prices, 30)).toBeGreaterThan(scriptCost(prices) * 2);
    expect(timedScriptCost(prices, { targetSec: 20, sceneSec: { min: 3, max: 5 } })).toBe(scriptCost(prices));
    const ten = timedScriptCost(prices, { targetSec: 600, sceneSec: { min: 3, max: 5 } });
    expect(ten).toBeCloseTo(scriptCost(prices) + 10 * scriptAnswerCost(prices, 20), 4);
    // more, shorter scenes are more to write
    expect(timedScriptCost(prices, { targetSec: 600, sceneSec: { min: 2, max: 2 } })).toBeGreaterThan(ten);
  });

  it("reads --duration and --scene-seconds, and refuses what a video or a clip cannot be", () => {
    expect(parseDuration("30")).toBe(30);
    for (const bad of ["25", "0", "660", "abc", ""]) expect(() => parseDuration(bad), bad).toThrow("--duration must be one of");
    expect(parseSceneSeconds("5")).toEqual({ min: 5, max: 5 });
    expect(parseSceneSeconds("3-5")).toEqual({ min: 3, max: 5 });
    for (const bad of ["1", "6", "1-5", "3-6", "5-3", "3.5", "a-b", "", "3-"]) expect(() => parseSceneSeconds(bad), bad).toThrow("--scene-seconds must be");
  });
});
