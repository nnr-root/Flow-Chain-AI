import { z } from "zod";

/** The one composition the bundle registers. */
export const COMPOSITION_ID = "FlowchainVideo";

/*
 * The render contract: the only input of the Remotion composition. Shared by Node (validation) and the
 * browser bundle, so it imports nothing but zod and knows nothing about the manifest.
 */

export const CameraMove = z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down"]);
export type CameraMove = z.infer<typeof CameraMove>;

export const Transition = z.enum(["cut", "fade", "dissolve", "blur", "zoom", "glitch"]);
export type Transition = z.infer<typeof Transition>;

export const CaptionStyleName = z.enum(["hormozi", "mrbeast", "minimalist"]);
export type CaptionStyleName = z.infer<typeof CaptionStyleName>;

export const CaptionStyle = z.object({
  /** `file` is a font file name under assets/fonts (staged next to the media). */
  font: z.object({ family: z.string(), file: z.string(), weight: z.number().int() }),
  textCase: z.enum(["upper", "none"]),
  /** Font size as a percentage of the frame's short side (1080 px for both 9:16 and 16:9). */
  sizePctOfShortSide: z.number().positive(),
  color: z.string(),
  activeColor: z.string(),
  /** 1 = every word fully opaque; below 1 dims the words that are not being spoken. */
  inactiveOpacity: z.number().min(0).max(1),
  /** Painted beneath the fill (paint-order: stroke fill), so about half of it shows outside the glyphs. */
  stroke: z.object({ color: z.string(), pctOfSize: z.number().positive() }).nullable(),
  shadow: z.string().nullable(),
  maxWordsPerPage: z.number().int().positive(),
  activeAnim: z.enum(["none", "pop", "fade"]),
});
export type CaptionStyle = z.infer<typeof CaptionStyle>;

export const CaptionToken = z.object({ text: z.string(), fromMs: z.number(), toMs: z.number() });
export type CaptionToken = z.infer<typeof CaptionToken>;

export const CaptionPage = z.object({
  text: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  tokens: z.array(CaptionToken),
});
export type CaptionPage = z.infer<typeof CaptionPage>;

export const SceneProps = z.discriminatedUnion("kind", [
  /** Mode 1: a fitted clip that is exactly `frames` frames long, played 1:1. */
  z.object({ kind: z.literal("video"), src: z.string(), from: z.number().int(), frames: z.number().int().positive() }),
  /** Mode 2: a keyframe animated with a Ken Burns camera move. */
  z.object({
    kind: z.literal("still"),
    src: z.string(),
    camera: CameraMove,
    from: z.number().int(),
    frames: z.number().int().positive(),
  }),
]);
export type SceneProps = z.infer<typeof SceneProps>;

export const Boundary = z.object({
  /** First frame of the incoming scene. */
  frame: z.number().int(),
  kind: z.enum(["seam", "cut"]),
  transition: Transition,
  /** The transition window is [frame - halfWindow, frame + halfWindow); 0 = hard cut. */
  halfWindow: z.number().int().min(0),
});
export type Boundary = z.infer<typeof Boundary>;

export const FrameRange = z.object({ from: z.number().int(), to: z.number().int() });
export type FrameRange = z.infer<typeof FrameRange>;

export const BgmProps = z.object({
  src: z.string(),
  gain: z.number().min(0).max(1),
  duckTo: z.number().min(0).max(1),
  rampFrames: z.number().int().positive(),
  fadeOutFrames: z.number().int().positive(),
});
export type BgmProps = z.infer<typeof BgmProps>;

/** The hook (first seconds): its title text and how long it shows, and the snap zoom at the start. */
export const HookProps = z.object({
  text: z.string().min(1),
  /** The title shows on frames [0, endFrame). */
  endFrame: z.number().int().positive(),
  zoomFrom: z.number().min(1),
  zoomFrames: z.number().int().positive(),
});
export type HookProps = z.infer<typeof HookProps>;

export const Corner = z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]);
export type Corner = z.infer<typeof Corner>;

/** The brand watermark: a logo at a corner, never zoomed. */
export const BrandProps = z.object({
  logo: z.string(),
  position: Corner,
  /** Logo width as a percentage of the frame width. */
  widthPct: z.number().positive(),
  opacity: z.number().min(0).max(1),
  /** Distance from the edges as a percentage of the frame's short side. */
  marginPct: z.number().min(0),
});
export type BrandProps = z.infer<typeof BrandProps>;

/** One sound effect: `src` starts playing at `frame` at `gain` (relative to the narration). */
export const SfxCue = z.object({ src: z.string(), frame: z.number().int().min(0), gain: z.number().min(0) });
export type SfxCue = z.infer<typeof SfxCue>;

export const RenderProps = z.object({
  fps: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  totalFrames: z.number().int().positive(),
  scenes: z.array(SceneProps),
  boundaries: z.array(Boundary),
  captions: z.object({ style: CaptionStyle, bottomPct: z.number(), pages: z.array(CaptionPage) }),
  /** null = no hook (no zoom, no title, no impact sound). The title uses `captions.style`. */
  hook: HookProps.nullable(),
  brand: BrandProps.nullable(),
  audio: z.object({
    narration: z.string(),
    bgm: BgmProps.nullable(),
    /** Frames where narration is speaking (merged and padded): the BGM ducks inside them. */
    speech: z.array(FrameRange),
    sfx: z.array(SfxCue),
  }),
});
export type RenderProps = z.infer<typeof RenderProps>;
