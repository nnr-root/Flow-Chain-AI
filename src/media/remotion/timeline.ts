import type { CameraMove, CaptionPage, FrameRange, Transition } from "./props.js";

/*
 * Pure timing math for the composition. Components only apply what these functions return, so every
 * rule here is unit-tested without Chrome.
 */

export const MAX_ZOOM = 1.15;

/** Sine ease-in-out on [0, 1]. */
export const easeInOut = (p: number): number => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, p)));

export type KenBurnsTransform = { scale: number; xPct: number; yPct: number };

/**
 * CSS `scale(s) translate(x%, y%)` for a Ken Burns camera at `frame` of `frames`. Translate percentages are of
 * the unscaled box, so the largest shift that keeps the frame covered at scale s is (s - 1) / (2s).
 * Pans keep Phase 1's meaning: pan_left moves the view to the left (the picture travels right).
 */
export function kenBurnsTransform(camera: CameraMove, frame: number, frames: number): KenBurnsTransform {
  const e = easeInOut(frame / Math.max(frames - 1, 1));
  const max = ((MAX_ZOOM - 1) / (2 * MAX_ZOOM)) * 100;
  const travel = -max + 2 * max * e;
  switch (camera) {
    case "zoom_in":
      return { scale: 1 + (MAX_ZOOM - 1) * e, xPct: 0, yPct: 0 };
    case "zoom_out":
      return { scale: MAX_ZOOM - (MAX_ZOOM - 1) * e, xPct: 0, yPct: 0 };
    case "pan_left":
      return { scale: MAX_ZOOM, xPct: travel, yPct: 0 };
    case "pan_right":
      return { scale: MAX_ZOOM, xPct: -travel, yPct: 0 };
    case "pan_up":
      return { scale: MAX_ZOOM, xPct: 0, yPct: travel };
    case "pan_down":
      return { scale: MAX_ZOOM, xPct: 0, yPct: -travel };
  }
}

/** Preferred half window (frames) per transition; `cut` has none. */
export const HALF_WINDOW: Record<Transition, number> = { cut: 0, fade: 5, dissolve: 5, blur: 5, zoom: 5, glitch: 3 };

/** The half window actually used: shrunk so it never exceeds half of either neighbouring scene. */
export function halfWindowFor(transition: Transition, prevFrames: number, nextFrames: number): number {
  return Math.max(0, Math.min(HALF_WINDOW[transition], Math.floor(prevFrames / 2), Math.floor(nextFrames / 2)));
}

export type LayerLook = { opacity: number; blurPx: number; scale: number };
/** What to draw at one frame of a transition window: A = outgoing scene, B = incoming (null = not drawn). */
export type TransitionLook = { a: LayerLook | null; b: LayerLook | null; glitch: boolean };

const PLAIN: LayerLook = { opacity: 1, blurPx: 0, scale: 1 };

/**
 * The look of a transition window at `local` (0 … 2h−1). The cut is at local = h: A is drawn (and played)
 * before it, B after it; blending transitions draw both.
 */
export function transitionLook(transition: Transition, local: number, h: number): TransitionLook {
  const q = local / (2 * h);
  const before = local < h;
  switch (transition) {
    case "cut":
      return before ? { a: PLAIN, b: null, glitch: false } : { a: null, b: PLAIN, glitch: false };
    case "fade":
      return { a: PLAIN, b: { ...PLAIN, opacity: q }, glitch: false };
    case "dissolve": {
      const blurPx = 6 * Math.sin(Math.PI * q);
      return { a: { ...PLAIN, blurPx }, b: { opacity: q, blurPx, scale: 1 }, glitch: false };
    }
    case "blur":
      return before
        ? { a: { ...PLAIN, blurPx: (20 * (local + 1)) / h }, b: null, glitch: false }
        : { a: null, b: { ...PLAIN, blurPx: (20 * (2 * h - 1 - local)) / h }, glitch: false };
    case "zoom":
      return {
        a: { opacity: 1 - q, blurPx: 0, scale: 1 + 0.25 * q },
        b: { opacity: q, blurPx: 0, scale: 1.25 - 0.25 * q },
        glitch: false,
      };
    case "glitch":
      return { a: before ? PLAIN : null, b: before ? null : PLAIN, glitch: local >= h - 1 && local <= h + 1 };
  }
}

/** Small deterministic PRNG (mulberry32): the same seed always gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type GlitchSlice = { topPct: number; heightPct: number; dxPct: number };
export type GlitchLook = { slices: GlitchSlice[]; channelShiftPct: number };

/** Glitch displacement for one frame, seeded by boundary index and frame so every render is identical. */
export function glitchLook(boundaryIndex: number, local: number, sliceCount = 6): GlitchLook {
  const rand = mulberry32(boundaryIndex * 1009 + local + 1);
  const heightPct = 100 / sliceCount;
  const slices = Array.from({ length: sliceCount }, (_, i) => ({
    topPct: i * heightPct,
    heightPct,
    dxPct: (rand() * 2 - 1) * 6,
  }));
  return { slices, channelShiftPct: 1 + rand() * 1.5 };
}

/** Index of the caption page visible at `ms`, or -1. A page shows from its start for `durationMs`. */
export function activePageIndex(pages: CaptionPage[], ms: number): number {
  for (let i = pages.length - 1; i >= 0; i--) {
    if (ms >= pages[i].startMs) return ms < pages[i].startMs + pages[i].durationMs ? i : -1;
  }
  return -1;
}

/** The token being spoken: the last one that has started (it stays active until the next starts), or -1. */
export function activeTokenIndex(page: CaptionPage, ms: number): number {
  let active = -1;
  page.tokens.forEach((t, i) => {
    if (t.fromMs <= ms) active = i;
  });
  return active;
}

/** Speech intervals in frames: gaps shorter than `mergeGapSec` are merged, then padded by `padSec`. */
export function speechRanges(
  words: Array<{ start: number; end: number }>,
  fps: number,
  totalFrames: number,
  mergeGapSec = 0.35,
  padSec = 0.1,
): FrameRange[] {
  const sorted = [...words].sort((x, y) => x.start - y.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of sorted) {
    const last = merged.at(-1);
    if (last && w.start - last.end < mergeGapSec) last.end = Math.max(last.end, w.end);
    else merged.push({ start: w.start, end: w.end });
  }
  const ranges: FrameRange[] = [];
  for (const m of merged) {
    const from = Math.max(0, Math.floor((m.start - padSec) * fps));
    const to = Math.min(totalFrames, Math.ceil((m.end + padSec) * fps));
    const last = ranges.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else if (to > from) ranges.push({ from, to });
  }
  return ranges;
}

/**
 * BGM level factor at `frame`: `duckTo` inside speech, 1 well away from it, and a linear ramp over
 * `rampFrames` frames before each speech start and after each speech end.
 */
export function duckVolume(frame: number, speech: FrameRange[], duckTo: number, rampFrames: number): number {
  let level = 1;
  for (const r of speech) {
    if (frame >= r.from && frame < r.to) return duckTo;
    const distance = frame < r.from ? r.from - frame : frame - (r.to - 1);
    if (distance <= rampFrames) level = Math.min(level, duckTo + ((1 - duckTo) * distance) / rampFrames);
  }
  return level;
}

/** Linear fade to silence over the last `fadeFrames` frames. */
export function fadeOutVolume(frame: number, totalFrames: number, fadeFrames: number): number {
  const start = totalFrames - fadeFrames;
  if (frame < start) return 1;
  return Math.max(0, (totalFrames - 1 - frame) / Math.max(fadeFrames - 1, 1));
}
