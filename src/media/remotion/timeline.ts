import type { CameraMove, CaptionPage, FinishProps, FrameRange, Transition } from "./props.js";

/*
 * Pure timing math for the composition. Components only apply what these functions return, so every
 * rule here is unit-tested without Chrome.
 */

export const MAX_ZOOM = 1.15;

/** Frames at `fps` for a duration that was tuned as `framesAt30` frames at 30 fps (phase 11 spec §5): identical at 30. */
export const framesAt = (framesAt30: number, fps: number): number => Math.round((framesAt30 * fps) / 30);

/** The hook in the first seconds (2.3 spec §4): snap zoom, then a title that pops in and fades out. */
export const HOOK = {
  seconds: 3,
  zoomFrom: 1.15,
  zoomFrames: 12,
  popFrames: 6,
  fadeFrames: 8,
  sizePctOfShortSide: 12,
  widthPct: 85,
  centerTopPct: 38,
} as const;

/** Cubic ease-out on [0, 1]: fast start, gentle landing. */
export const easeOutCubic = (p: number): number => 1 - (1 - Math.min(1, Math.max(0, p))) ** 3;

/** Snap zoom: `zoomFrom` at frame 0 easing back to 1 over `zoomFrames` frames. */
export function zoomAt(frame: number, zoomFrom: number, zoomFrames: number): number {
  if (frame >= zoomFrames) return 1;
  return 1 + (zoomFrom - 1) * (1 - easeOutCubic(frame / zoomFrames));
}

/**
 * Splits the hook into one line or two balanced lines, whichever lets it be drawn bigger. `fit` returns the
 * largest font size at which a line fits the width; the result is capped at `wanted`. Ties keep one line.
 */
export function hookLines(words: string[], fit: (line: string) => number, wanted: number, joiner = " "): { lines: string[]; fontSize: number } {
  let best = { lines: [words.join(joiner)], fontSize: Math.min(wanted, fit(words.join(joiner))) };
  for (let k = 1; k < words.length; k++) {
    const lines = [words.slice(0, k).join(joiner), words.slice(k).join(joiner)];
    const fontSize = Math.min(wanted, ...lines.map(fit));
    if (fontSize > best.fontSize) best = { lines, fontSize };
  }
  return best;
}

export type HookTitleLook = { visible: boolean; scale: number; opacity: number };

/** The hook title at `frame`: pops in from 0.6× over `popFrames`, holds, fades out over the last `fadeFrames` (both tuned at 30 fps). */
export function hookTitleLook(frame: number, endFrame: number, fps = 30): HookTitleLook {
  if (frame < 0 || frame >= endFrame) return { visible: false, scale: 1, opacity: 0 };
  const scale = 0.6 + 0.4 * easeOutCubic(frame / framesAt(HOOK.popFrames, fps));
  const opacity = Math.min(1, (endFrame - frame) / framesAt(HOOK.fadeFrames, fps));
  return { visible: true, scale, opacity };
}

/** How long a caption word's pop or fade-in lasts, in frames at 30 fps. */
const CAPTION_ANIM_FRAMES = 4;

/** The active word's pop: 1.15× at its start, settling to 1 over the animation's length. */
export const popScale = (sinceStart: number, fps: number): number => 1 + 0.15 * Math.max(0, 1 - sinceStart / framesAt(CAPTION_ANIM_FRAMES, fps));

/** The active word's fade-in from the style's inactive opacity up to 1. */
export const fadeInOpacity = (sinceStart: number, inactiveOpacity: number, fps: number): number =>
  Math.min(1, inactiveOpacity + sinceStart / framesAt(CAPTION_ANIM_FRAMES, fps));

/** Sine ease-in-out on [0, 1]. */
export const easeInOut = (p: number): number => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, p)));

export type KenBurnsTransform = { scale: number; xPct: number; yPct: number };

/**
 * CSS `scale(s) translate(x%, y%)` for a Ken Burns camera at `frame` of `frames`. Translate percentages are of
 * the unscaled box, so the largest shift that keeps the frame covered at scale s is (s - 1) / (2s).
 * Pans keep Phase 1's meaning: pan_left moves the view to the left (the picture travels right).
 */
export function kenBurnsTransform(camera: CameraMove, frame: number, frames: number, pace = 1): KenBurnsTransform {
  const e = easeInOut(frame / Math.max(frames - 1, 1));
  // an edit's pace (phase 8 spec §3) moves the camera further or less far; 1 is the move every run had before
  const zoom = 1 + (MAX_ZOOM - 1) * pace;
  const max = ((zoom - 1) / (2 * zoom)) * 100;
  const travel = -max + 2 * max * e;
  switch (camera) {
    case "zoom_in":
      return { scale: 1 + (zoom - 1) * e, xPct: 0, yPct: 0 };
    case "zoom_out":
      return { scale: zoom - (zoom - 1) * e, xPct: 0, yPct: 0 };
    case "pan_left":
      return { scale: zoom, xPct: travel, yPct: 0 };
    case "pan_right":
      return { scale: zoom, xPct: -travel, yPct: 0 };
    case "pan_up":
      return { scale: zoom, xPct: 0, yPct: travel };
    case "pan_down":
      return { scale: zoom, xPct: 0, yPct: -travel };
  }
}

/** Preferred half window (frames at 30 fps) per transition; `cut` has none. */
export const HALF_WINDOW: Record<Transition, number> = { cut: 0, fade: 5, dissolve: 5, blur: 5, zoom: 5, glitch: 3 };

/** The half window actually used: shrunk so it never exceeds half of either neighbouring scene. */
export function halfWindowFor(transition: Transition, prevFrames: number, nextFrames: number, fps = 30): number {
  return Math.max(0, Math.min(framesAt(HALF_WINDOW[transition], fps), Math.floor(prevFrames / 2), Math.floor(nextFrames / 2)));
}

export type LayerLook = { opacity: number; blurPx: number; scale: number };
/** What to draw at one frame of a transition window: A = outgoing scene, B = incoming (null = not drawn). */
export type TransitionLook = { a: LayerLook | null; b: LayerLook | null; glitch: boolean };

const PLAIN: LayerLook = { opacity: 1, blurPx: 0, scale: 1 };

/**
 * The look of a transition window at `local` (0 … 2h−1). The cut is at local = h: A is drawn (and played)
 * before it, B after it; blending transitions draw both. The blend `q` steps evenly up to exactly 1 on the
 * window's last frame, so the frame after the window continues it without a jump.
 */
export function transitionLook(transition: Transition, local: number, h: number): TransitionLook {
  const q = (local + 1) / (2 * h);
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
    case "glitch": {
      // One frame either side of the cut at 30 fps (h = 3); the window's half is scaled with fps, so is the flash.
      const flash = Math.max(1, Math.round(h / 3));
      return { a: before ? PLAIN : null, b: before ? null : PLAIN, glitch: local >= h - flash && local <= h + flash };
    }
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
 * BGM level factor at `frame`: `duckTo` inside speech, 1 well away from it, and an S-curve (easeInOut) over
 * `rampFrames` frames before each speech start and after each speech end, so the music never audibly pumps.
 */
export function duckVolume(frame: number, speech: FrameRange[], duckTo: number, rampFrames: number): number {
  let level = 1;
  for (const r of speech) {
    if (frame >= r.from && frame < r.to) return duckTo;
    const distance = frame < r.from ? r.from - frame : frame - (r.to - 1);
    if (distance <= rampFrames) level = Math.min(level, duckTo + (1 - duckTo) * easeInOut(distance / rampFrames));
  }
  return level;
}

/** Linear fade to silence over the last `fadeFrames` frames. */
export function fadeOutVolume(frame: number, totalFrames: number, fadeFrames: number): number {
  const start = totalFrames - fadeFrames;
  if (frame < start) return 1;
  return Math.max(0, (totalFrames - 1 - frame) / Math.max(fadeFrames - 1, 1));
}

/** The CSS filter of an edit's grade (phase 8 spec §3): only the amounts that change the picture. */
export function finishFilter(f: FinishProps): string | undefined {
  const parts = [
    f.contrast !== 1 ? `contrast(${f.contrast})` : "",
    f.saturate !== 1 ? `saturate(${f.saturate})` : "",
    f.brightness !== 1 ? `brightness(${f.brightness})` : "",
    f.sepia > 0 ? `sepia(${f.sepia})` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

/** Where the grain's tile sits on a frame: it jumps every frame, the same way on every render of it. */
export const grainOffset = (frame: number): { x: number; y: number } => ({ x: (frame * 73) % 256, y: (frame * 151) % 256 });

/** A bed's level at its own frame: ramps up over `fade` frames at the start and down over `fade` at the end. */
export function bedVolume(frame: number, total: number, fade: number): number {
  if (fade <= 0) return 1;
  return Math.max(0, Math.min(1, frame / fade, (total - frame) / fade));
}

/**
 * Scene sound mix (phase 14 spec §5): ducked to half under speech with 10-frame ramps, 6 frames of fade at each of the
 * scene's cuts, and a base level under the studio's "Sound effects" level; frames at 30 fps, scaled with `framesAt`.
 * Here, not in the props, so the studio's player and the render read the same numbers; `build-render-props` re-exports it.
 */
export const SOUND_MIX = { duckTo: 0.5, rampFrames: 10, fadeFrames: 6, baseGain: 0.5 } as const;

/**
 * A scene sound's level at `frame` (local to its Sequence): `gain`, faded in and out over `fadeFrames` at the scene's
 * own cuts, and ducked while the narration speaks. The duck reads the video's frame, `from + frame`, since `speech` is on
 * the video's clock while Remotion hands a Sequence's volume callback its own frame.
 */
export function sceneSoundVolume(
  frame: number,
  frames: number,
  fadeFrames: number,
  speech: FrameRange[],
  duckTo: number,
  rampFrames: number,
  gain: number,
  from = 0,
): number {
  // the last rendered frame is frames - 1, so the fade reaches silence on it (as fadeOutVolume does)
  return gain * bedVolume(frame, frames - 1, fadeFrames) * duckVolume(from + frame, speech, duckTo, rampFrames);
}
