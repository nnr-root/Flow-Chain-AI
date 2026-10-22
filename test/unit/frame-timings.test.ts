import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { wordsToCaptions } from "../../src/media/remotion/caption-pages.js";
import {
  fadeInOpacity,
  framesAt,
  HALF_WINDOW,
  halfWindowFor,
  HOOK,
  hookTitleLook,
  popScale,
} from "../../src/media/remotion/timeline.js";
import { BGM_MIX, buildRenderProps } from "../../src/stages/build-render-props.js";
import { globalWords } from "../../src/stages/captions.js";
import { fakeScript } from "../fakes/providers.js";

describe("framesAt (phase 11 spec §5)", () => {
  it("is the identity at 30 and doubles at 60", () => {
    for (const n of [0, 1, 3, 4, 5, 6, 8, 10, 12, 30]) {
      expect(framesAt(n, 30)).toBe(n);
      expect(framesAt(n, 60)).toBe(2 * n);
    }
  });
  it("rounds odd values to whole frames", () => {
    expect(framesAt(5, 24)).toBe(4); // 4 exactly
    expect(framesAt(3, 25)).toBe(3); // 2.5 rounds up
    expect(framesAt(7, 50)).toBe(12); // 11.67
  });
});

describe("the hook's windows follow the frame rate", () => {
  it("pops in and fades out over twice the frames at 60", () => {
    // at 30: the constants every run had before
    expect(hookTitleLook(HOOK.popFrames, 90, 30)).toEqual({ visible: true, scale: 1, opacity: 1 });
    expect(hookTitleLook(86, 90, 30).opacity).toBeCloseTo(4 / 8, 9);
    // at 60: the same look at twice the frame
    expect(hookTitleLook(2 * HOOK.popFrames, 180, 60)).toEqual({ visible: true, scale: 1, opacity: 1 });
    expect(hookTitleLook(2 * HOOK.popFrames - 3, 180, 60).scale).toBeCloseTo(hookTitleLook(HOOK.popFrames - 1.5, 90, 30).scale, 9);
    expect(hookTitleLook(172, 180, 60).opacity).toBeCloseTo(8 / 16, 9);
  });
});

describe("a transition's half window follows the frame rate", () => {
  it("is twice as long at 60 for every kind, equal at 30, and still clamped by half of each neighbour", () => {
    for (const [kind, at30] of Object.entries(HALF_WINDOW)) {
      const t = kind as keyof typeof HALF_WINDOW;
      expect(halfWindowFor(t, 1000, 1000, 30)).toBe(at30);
      expect(halfWindowFor(t, 1000, 1000, 60)).toBe(2 * at30);
    }
    expect(halfWindowFor("fade", 7, 1000, 60)).toBe(3);
    expect(halfWindowFor("fade", 1000, 9, 60)).toBe(4);
  });
});

describe("a caption's pop and fade follow the frame rate", () => {
  it("last twice the frames at 60", () => {
    expect(popScale(2, 30)).toBeCloseTo(1.075, 9);
    expect(popScale(4, 60)).toBeCloseTo(1.075, 9);
    expect(popScale(40, 60)).toBe(1);
    expect(fadeInOpacity(2, 0.5, 30)).toBeCloseTo(1, 9);
    expect(fadeInOpacity(4, 0.5, 60)).toBeCloseTo(1, 9);
    expect(fadeInOpacity(2, 0.5, 60)).toBeCloseTo(0.75, 9);
  });
});

describe("the music's ramps follow the run's frame rate", () => {
  function manifest() {
    const m = createManifest(
      "r",
      { topic: "t", aspect: "9:16", sceneCount: 1, modes: [2], voiceId: "v", bgm: "/music/song.mp3", render: { captionStyle: "minimalist", transition: "dissolve", bgmGain: 0.5, hook: true, sfx: false, sfxGain: 0.6 } },
      { llm: "l", tts: "t", image: "i", video: "v" },
    );
    m.script = fakeScript(1, { shots: ["cut"], cameras: ["zoom_in"] });
    m.scenes[0].audio = { path: "audio/scene_01.wav", duration: 4, removedSec: 0, words: [{ text: "w", start: 0.1, end: 0.6 }] };
    return m;
  }
  const at = (fps: number) => {
    const m = manifest();
    return buildRenderProps(m, { dir: "/run", fontsDir: "/f", sfxDir: "/s", fps, size: { width: 1080, height: 1920 } }, wordsToCaptions(globalWords(m), 6)).props;
  };
  it("keeps BGM_MIX as the at-30 constants", () => {
    expect(BGM_MIX).toEqual({ duckTo: 0.4, rampFrames: 10, fadeOutFrames: 30 });
  });
  it("is 10 and 30 frames at 30 and 20 and 60 at 60, and the hook's zoom likewise", () => {
    expect(at(30).audio.bgm).toMatchObject({ rampFrames: 10, fadeOutFrames: 30 });
    expect(at(60).audio.bgm).toMatchObject({ rampFrames: 20, fadeOutFrames: 60 });
    expect(at(30).hook?.zoomFrames).toBe(12);
    expect(at(60).hook?.zoomFrames).toBe(24);
  });
});
