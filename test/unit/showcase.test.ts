import { describe, expect, it } from "vitest";
import { peaksOf, publications, receiptOf, republish, slugOf } from "../../src/deploy/showcase.js";

const models = { llm: "gemini-flash-latest", tts: "eleven_multilingual_v2", image: "runpod:abc123keyframe/keyframe-sdxl@1", video: "runpod:abc123clip/clip-wan22-480p@1" };

describe("a showcase video's receipt", () => {
  it("is the run's own ledger, grouped the way a video is made, and adds up to the cent's hundredth", () => {
    // (the ledger of a real run on our own GPU: one script, a character reference, four narrations, four pictures, three clips)
    const ledger = [
      { stage: "script", usd: 0.0055 }, { stage: "reference", usd: 0.0139 },
      { stage: "tts", usd: 0.0282 }, { stage: "tts", usd: 0.0288 }, { stage: "tts", usd: 0.03 }, { stage: "tts", usd: 0.0276 },
      { stage: "keyframes", usd: 0.0181 }, { stage: "keyframes", usd: 0.0019 }, { stage: "keyframes", usd: 0.0018 }, { stage: "keyframes", usd: 0.0018 },
      { stage: "clips", usd: 0.0537 }, { stage: "clips", usd: 0.0535 }, { stage: "clips", usd: 0.0521 },
    ];
    expect(receiptOf(ledger, models)).toEqual({
      lines: [{ label: "Script", usd: 0.0055 }, { label: "Voice", usd: 0.1146 }, { label: "Pictures", usd: 0.0375 }, { label: "Clips", usd: 0.1593 }],
      totalUsd: 0.3169,
      madeOn: "own",
      clipHeight: 480,
    });
    const hosted = receiptOf(ledger, { ...models, image: "fal-ai/flux/dev", video: "fal-ai/kling-video/v2.1/standard/image-to-video" });
    expect(hosted.madeOn).toBe("hosted");
    expect(hosted).not.toHaveProperty("clipHeight");
  });

  it("leaves out what cost nothing, keeps what it does not know under its own line, and refuses what is no amount", () => {
    expect(receiptOf([{ stage: "script", usd: 0.005 }, { stage: "render", usd: 0 }, { stage: "upscale", usd: 0.2 }], models).lines).toEqual([{ label: "Script", usd: 0.005 }, { label: "Other", usd: 0.2 }]);
    expect(receiptOf([], models)).toMatchObject({ lines: [], totalUsd: 0 });
    for (const usd of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(() => receiptOf([{ stage: "clips", usd }], models)).toThrow("no amount");
  });

  it("publishes no model, no company and no endpoint: only where the video was made, and the height of its clips", () => {
    for (const video of ["runpod:abc123secret/clip-wan22-720p@2", "runpod:abc123secret/clip-wan22-480p@1", "runpod:abc123secret", "fal-ai/kling-video/v2.1/standard/image-to-video"]) {
      const published = JSON.stringify(receiptOf([{ stage: "clips", usd: 0.05 }], { ...models, video }));
      expect(published).not.toMatch(/abc123secret|runpod|wan|kling|fal|gemini|eleven|sdxl/i);
    }
    expect(receiptOf([], { ...models, video: "runpod:abc123secret/clip-wan22-720p@2" }).clipHeight).toBe(720);
    // a run that chose its clip size says so in its profile, and that is what is published
    expect(receiptOf([], models, "wan22-720p@1").clipHeight).toBe(720);
    expect(receiptOf([], models, "wan22-480p@1").clipHeight).toBe(480);
    // a graph whose name says no height: nothing is guessed
    expect(receiptOf([], { ...models, video: "runpod:abc123secret/clip-next@1" })).not.toHaveProperty("clipHeight");
  });
});

describe("the voice as a row of bars", () => {
  it("is the loudest moment of each stretch, against the loudest of all", () => {
    expect(peaksOf(Int16Array.from([0, 100, -200, 50, 400, -400, 0, 0]), 4)).toEqual([0.25, 0.5, 1, 0]);
    // more bars than samples, silence, and nothing at all
    expect(peaksOf(Int16Array.from([10, -20]), 4)).toHaveLength(4);
    expect(peaksOf(new Int16Array(8), 2)).toEqual([0, 0]);
    expect(peaksOf(new Int16Array(0), 4)).toEqual([]);
  });
});

describe("publishing a run's files", () => {
  const published = ["fitted/scene_01.mp4", "images/keyframe_02.png", "narration.wav", "bgm.mp3", "sfx/whoosh.mp3", "Bangers-Regular.ttf", "logo.svg", "brand/logo.png"];

  it("makes clips and pictures small, the narration an MP3, and copies the rest", () => {
    expect(publications(published)).toEqual([
      { from: "fitted/scene_01.mp4", to: "fitted/scene_01.mp4", how: "video" },
      { from: "images/keyframe_02.png", to: "images/keyframe_02.jpg", how: "picture" },
      { from: "narration.wav", to: "narration.mp3", how: "narration" },
      { from: "bgm.mp3", to: "bgm.mp3", how: "copy" },
      { from: "sfx/whoosh.mp3", to: "sfx/whoosh.mp3", how: "copy" },
      { from: "Bangers-Regular.ttf", to: "Bangers-Regular.ttf", how: "copy" },
      { from: "logo.svg", to: "logo.svg", how: "copy" },
      // a logo keeps its format, and with it its transparency
      { from: "brand/logo.png", to: "brand/logo.png", how: "copy" },
    ]);
  });

  it("points the player's props at what was published, and touches no other text", () => {
    const props = {
      scenes: [{ kind: "video", src: "fitted/scene_01.mp4", from: 0 }, { kind: "still", src: "images/keyframe_02.png", from: 90 }],
      hook: { text: "narration.wav is not a title, but images/keyframe_02.png in a sentence stays" },
      audio: { narration: "narration.wav", bgm: { src: "bgm.mp3", gain: 0.35 }, sfx: [{ src: "sfx/whoosh.mp3", frame: 90, gain: 1 }] },
      brand: null,
    };
    expect(republish(props, publications(published))).toEqual({
      ...props,
      scenes: [props.scenes[0], { ...props.scenes[1], src: "images/keyframe_02.jpg" }],
      audio: { ...props.audio, narration: "narration.mp3" },
    });
  });

  it("takes only a plain name for the address", () => {
    expect(slugOf("clockmaker")).toBe("clockmaker");
    for (const not of [undefined, "", "../x", "Clock Maker", "a/b", "x".repeat(41)]) expect(() => slugOf(not)).toThrow("--slug must be");
  });
});
