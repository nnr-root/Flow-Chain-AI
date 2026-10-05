import { describe, expect, it } from "vitest";
import { CameraMove, type CaptionPage, Transition } from "../../src/media/remotion/props.js";
import {
  activePageIndex,
  activeTokenIndex,
  duckVolume,
  easeInOut,
  easeOutCubic,
  fadeOutVolume,
  glitchLook,
  HOOK,
  halfWindowFor,
  hookLines,
  hookTitleLook,
  kenBurnsTransform,
  MAX_ZOOM,
  speechRanges,
  transitionLook,
  zoomAt,
} from "../../src/media/remotion/timeline.js";

describe("kenBurnsTransform", () => {
  const max = ((MAX_ZOOM - 1) / (2 * MAX_ZOOM)) * 100; // ≈ 6.52 %: the largest shift that keeps the frame covered

  it("zooms around the centre with a sine ease", () => {
    expect(kenBurnsTransform("zoom_in", 0, 31)).toEqual({ scale: 1, xPct: 0, yPct: 0 });
    expect(kenBurnsTransform("zoom_in", 15, 31).scale).toBeCloseTo(1.075, 6);
    expect(kenBurnsTransform("zoom_in", 30, 31).scale).toBeCloseTo(1.15, 6);
    expect(kenBurnsTransform("zoom_out", 0, 31).scale).toBeCloseTo(1.15, 6);
    expect(kenBurnsTransform("zoom_out", 30, 31).scale).toBeCloseTo(1, 6);
  });

  it("pans edge to edge at a fixed 1.15 zoom (pan_left: the picture travels right)", () => {
    expect(kenBurnsTransform("pan_left", 0, 31)).toEqual({ scale: MAX_ZOOM, xPct: -max, yPct: 0 });
    expect(kenBurnsTransform("pan_left", 30, 31).xPct).toBeCloseTo(max, 6);
    expect(kenBurnsTransform("pan_right", 0, 31).xPct).toBeCloseTo(max, 6);
    expect(kenBurnsTransform("pan_up", 30, 31).yPct).toBeCloseTo(max, 6);
    expect(kenBurnsTransform("pan_down", 30, 31).yPct).toBeCloseTo(-max, 6);
  });

  it("never leaves the frame uncovered and handles one-frame scenes", () => {
    for (const camera of CameraMove.options) {
      for (const f of [0, 7, 15, 23, 30]) {
        const t = kenBurnsTransform(camera, f, 31);
        expect(t.scale).toBeGreaterThanOrEqual(1);
        expect(Math.abs(t.xPct)).toBeLessThanOrEqual(((t.scale - 1) / (2 * t.scale)) * 100 + 1e-9);
        expect(Math.abs(t.yPct)).toBeLessThanOrEqual(((t.scale - 1) / (2 * t.scale)) * 100 + 1e-9);
      }
      expect(kenBurnsTransform(camera, 0, 1).scale).toBeGreaterThanOrEqual(1);
    }
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(2)).toBe(1);
  });
});

describe("transition windows", () => {
  it("uses 5 frames per side (glitch 3, cut 0) and shrinks next to short scenes", () => {
    expect(halfWindowFor("fade", 100, 100)).toBe(5);
    expect(halfWindowFor("glitch", 100, 100)).toBe(3);
    expect(halfWindowFor("cut", 100, 100)).toBe(0);
    expect(halfWindowFor("fade", 7, 100)).toBe(3);
    expect(halfWindowFor("zoom", 100, 1)).toBe(0);
  });

  it("fades B over a fully drawn A in even steps, reaching 100 % on the window's last frame", () => {
    expect(transitionLook("fade", 0, 5)).toEqual({
      a: { opacity: 1, blurPx: 0, scale: 1 },
      b: { opacity: 0.1, blurPx: 0, scale: 1 },
      glitch: false,
    });
    expect(transitionLook("fade", 5, 5).b?.opacity).toBeCloseTo(0.6, 9);
    expect(transitionLook("fade", 9, 5).b?.opacity).toBe(1);
  });

  it("switches between A and B at the boundary for cut, blur and glitch", () => {
    for (const t of ["cut", "blur", "glitch"] as const) {
      expect(transitionLook(t, 4, 5).a).not.toBeNull();
      expect(transitionLook(t, 4, 5).b).toBeNull();
      expect(transitionLook(t, 5, 5).a).toBeNull();
      expect(transitionLook(t, 5, 5).b).not.toBeNull();
    }
    expect(transitionLook("blur", 4, 5).a?.blurPx).toBe(20);
    expect(transitionLook("blur", 9, 5).b?.blurPx).toBe(0);
    expect([1, 2, 3, 4, 5].map((l) => transitionLook("glitch", l, 3).glitch)).toEqual([false, true, true, true, false]);
  });

  it("scales and cross-fades for zoom, blurs at the middle for dissolve", () => {
    const z = transitionLook("zoom", 4, 5); // q = 0.5
    expect(z.a).toEqual({ opacity: 0.5, blurPx: 0, scale: 1.125 });
    expect(z.b).toEqual({ opacity: 0.5, blurPx: 0, scale: 1.125 });
    expect(transitionLook("dissolve", 4, 5).a?.blurPx).toBeCloseTo(6, 6);
  });

  it("ends zoom and dissolve fully on B, so the frame after the window continues without a jump", () => {
    const z = transitionLook("zoom", 9, 5);
    expect(z.a?.opacity).toBe(0);
    expect(z.b).toEqual({ opacity: 1, blurPx: 0, scale: 1 });
    const d = transitionLook("dissolve", 9, 5);
    expect(d.b?.opacity).toBe(1);
    expect(d.b?.blurPx).toBeCloseTo(0, 9);
  });

  it("covers every transition", () => {
    for (const t of Transition.options) expect(() => transitionLook(t, 1, 5)).not.toThrow();
  });

  it("glitches identically on every render", () => {
    expect(glitchLook(2, 4)).toEqual(glitchLook(2, 4));
    expect(glitchLook(2, 4)).not.toEqual(glitchLook(3, 4));
    expect(glitchLook(2, 4).slices).toHaveLength(6);
  });
});

describe("caption timing", () => {
  const pages: CaptionPage[] = [
    {
      text: "hello big",
      startMs: 100,
      durationMs: 900,
      tokens: [
        { text: "hello", fromMs: 100, toMs: 500 },
        { text: " big", fromMs: 600, toMs: 900 },
      ],
    },
    { text: "world.", startMs: 1000, durationMs: 400, tokens: [{ text: "world.", fromMs: 1000, toMs: 1400 }] },
  ];

  it("shows each page from its start for its duration", () => {
    expect(activePageIndex(pages, 50)).toBe(-1);
    expect(activePageIndex(pages, 100)).toBe(0);
    expect(activePageIndex(pages, 999)).toBe(0);
    expect(activePageIndex(pages, 1000)).toBe(1);
    expect(activePageIndex(pages, 1400)).toBe(-1);
  });

  it("keeps a word active until the next one starts", () => {
    expect(activeTokenIndex(pages[0], 100)).toBe(0);
    expect(activeTokenIndex(pages[0], 550)).toBe(0);
    expect(activeTokenIndex(pages[0], 600)).toBe(1);
  });
});

describe("BGM ducking", () => {
  it("merges short gaps, pads by 0.1 s and clamps to the timeline", () => {
    const words = [
      { start: 0.05, end: 0.5 },
      { start: 0.7, end: 1.0 }, // 0.2 s gap: merged
      { start: 2.0, end: 2.5 }, // 1 s gap: separate
    ];
    expect(speechRanges(words, 30, 80)).toEqual([
      { from: 0, to: 33 },
      { from: 57, to: 78 },
    ]);
  });

  it("ducks inside speech, ramps with an S-curve over the ramp frames, and is 1 well away", () => {
    const speech = [{ from: 30, to: 60 }];
    expect(duckVolume(29, speech, 0.18, 6)).toBeCloseTo(0.18 + 0.82 * easeInOut(1 / 6), 9); // 1 frame before
    expect(duckVolume(45, speech, 0.18, 6)).toBe(0.18);
    expect(duckVolume(0, speech, 0.18, 6)).toBe(1);
    expect(duckVolume(27, speech, 0.18, 6)).toBeCloseTo(0.18 + 0.82 * 0.5, 6); // 3 frames before speech
    expect(duckVolume(62, speech, 0.18, 6)).toBeCloseTo(0.18 + (0.82 * 3) / 6, 6); // 3 frames after the last
    expect(duckVolume(80, speech, 0.18, 6)).toBe(1);
  });

  it("fades out over the last frames", () => {
    expect(fadeOutVolume(0, 100, 30)).toBe(1);
    expect(fadeOutVolume(69, 100, 30)).toBe(1);
    expect(fadeOutVolume(70, 100, 30)).toBe(1);
    expect(fadeOutVolume(99, 100, 30)).toBe(0);
  });
});

describe("hook timing", () => {
  it("snaps from 1.15× back to 1 over 12 frames", () => {
    expect(zoomAt(0, 1.15, 12)).toBeCloseTo(1.15, 9);
    expect(zoomAt(6, 1.15, 12)).toBeCloseTo(1 + 0.15 * (1 - easeOutCubic(0.5)), 9);
    expect(zoomAt(12, 1.15, 12)).toBe(1);
    expect(zoomAt(200, 1.15, 12)).toBe(1);
  });

  it("pops the title in from 0.6×, holds it, and fades it out before endFrame", () => {
    expect(hookTitleLook(0, 90)).toEqual({ visible: true, scale: 0.6, opacity: 1 });
    expect(hookTitleLook(HOOK.popFrames, 90)).toEqual({ visible: true, scale: 1, opacity: 1 });
    expect(hookTitleLook(81, 90).opacity).toBe(1);
    expect(hookTitleLook(86, 90).opacity).toBeCloseTo(4 / 8, 9);
    expect(hookTitleLook(89, 90).opacity).toBeCloseTo(1 / 8, 9);
    expect(hookTitleLook(90, 90).visible).toBe(false);
  });
});

describe("hookLines", () => {
  // a line fits at 1000 / (characters): longer lines must be drawn smaller
  const fit = (line: string) => 1000 / line.length;

  it("splits into the two balanced lines that allow the biggest font", () => {
    expect(hookLines(["3", "minutes", "to", "midnight"], fit, 500)).toEqual({
      lines: ["3 minutes", "to midnight"],
      fontSize: 1000 / 11,
    });
  });

  it("keeps one line when it already reaches the wanted size", () => {
    expect(hookLines(["Run"], fit, 100)).toEqual({ lines: ["Run"], fontSize: 100 });
    expect(hookLines(["Go", "now"], fit, 50)).toEqual({ lines: ["Go now"], fontSize: 50 });
  });
});
