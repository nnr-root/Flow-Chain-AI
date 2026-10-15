import type { Transition } from "./media/remotion/props.js";

/*
 * How a video moves and is cut (phase 8 spec §3): its edit. A style says how a picture is drawn; an edit says how
 * the camera moves over it, how one scene gives way to the next, and the finish laid over the whole frame. The two
 * are chosen apart, so the words of an edit never name a medium, a colour or anything in the frame: they speak of
 * light, distance, angle and movement, which any style can take. (An edit that named "pastel" would turn a
 * black-and-white film to colour; one that named a lens type fights a drawn look.)
 *
 * An edit reaches a video in four places: the script is told how to frame and cut (`script`); every picture and
 * every clip is asked for with its words (`picture`, `motion`); the cuts the script suggests are turned into the
 * edit's own (`transitions`); and the renderer lays its finish over the frame and moves stills at its pace
 * (`finish`, `stillMotion`). The last two cost nothing: they are the render's.
 *
 * Pure data: read by the CLI, the stages, the renderer and the browser.
 */

/** What the renderer lays over the picture (never over the captions): a grade, a vignette, grain, scan lines. */
export type Finish = {
  /** CSS filter amounts; 1 is the picture as it is. */
  contrast: number;
  saturate: number;
  brightness: number;
  /** 0 to 1. */
  sepia: number;
  /** How dark the corners go, 0 to 1. */
  vignette: number;
  /** How strong the moving film grain is, 0 to 1. */
  grain: number;
  /** A video tape's lines across the frame. */
  scanlines: boolean;
};

/** The cuts a script may suggest ("zoom" is its zoom_transition). */
type Suggested = "cut" | "fade" | "dissolve" | "zoom";

export type Edit = {
  id: string;
  label: string;
  about: string;
  /** For the script's model: how scenes are framed, moved and cut. */
  script: readonly string[];
  /** Added to every picture's prompt: light and framing only. */
  picture: string;
  /** Added to every clip's prompt: how the camera moves. */
  motion: string;
  /** The cut the render makes for each cut a script suggests. */
  transitions: Record<Suggested, Transition>;
  /** How far a still's camera move travels, against the usual one. */
  stillMotion: number;
  finish: Finish;
};

const PLAIN: Finish = { contrast: 1, saturate: 1, brightness: 1, sepia: 0, vignette: 0, grain: 0, scanlines: false };

export const EDITS: readonly Edit[] = [
  {
    id: "cinematic",
    label: "Cinematic",
    about: "Slow, deliberate camera, deep shadows, film grain",
    script: [
      "Camera: slow push-ins, orbits and reveals; open a place on a wide shot, then go close.",
      'Cuts: "fade" or "dissolve" into a new place or time, "cut" within one; no "zoom_transition".',
    ],
    picture: "Dramatic directional light with deep shadows, strong depth between foreground and background",
    motion: "Slow, deliberate camera move, smooth as on a dolly",
    transitions: { cut: "cut", fade: "fade", dissolve: "dissolve", zoom: "dissolve" },
    stillMotion: 0.8,
    finish: { ...PLAIN, contrast: 1.08, saturate: 0.92, vignette: 0.35, grain: 0.05 },
  },
  {
    id: "energetic",
    label: "Fast and punchy",
    about: "Quick moves, close framing, hard cuts",
    script: [
      "Camera: fast push-ins, swift pans and close-ups; each scene's framing jumps from the one before.",
      'Cuts: "cut" and "zoom_transition"; "fade" only for a jump in time.',
      'Narration in short, punchy lines; actionLevel "high" wherever something moves.',
    ],
    picture: "Bold dynamic angle, close framing, crisp high-contrast light",
    motion: "Quick, energetic camera move, a fast push-in or a swift pan",
    transitions: { cut: "cut", fade: "blur", dissolve: "blur", zoom: "zoom" },
    stillMotion: 1.4,
    finish: { ...PLAIN, contrast: 1.1, saturate: 1.12, vignette: 0.15 },
  },
  {
    id: "calm",
    label: "Calm",
    about: "Still or slowly drifting camera, soft light, gentle fades",
    script: [
      "Camera: static or a very slow drift; wide shots with room around the subject.",
      'Cuts: "fade" and "dissolve"; actionLevel "low" or "medium".',
    ],
    picture: "Soft, even light, open space around the subject, a quiet composition",
    motion: "Very slow, gentle camera drift, almost still",
    transitions: { cut: "dissolve", fade: "fade", dissolve: "dissolve", zoom: "dissolve" },
    stillMotion: 0.6,
    finish: { ...PLAIN, contrast: 0.96, saturate: 0.92, vignette: 0.2 },
  },
  {
    id: "archive",
    label: "Archive film",
    about: "An old documentary: slow pans, faded tones, heavy grain",
    script: [
      "Camera: slow pans and push-ins across frames that feel like photographs of the moment.",
      'Cuts: "cut" and "fade"; actionLevel "low" or "medium".',
    ],
    picture: "Soft, faded contrast, as in an old photograph",
    motion: "Slow, steady pan across the frame",
    transitions: { cut: "cut", fade: "fade", dissolve: "dissolve", zoom: "cut" },
    stillMotion: 0.9,
    finish: { ...PLAIN, contrast: 1.05, saturate: 0.7, sepia: 0.45, vignette: 0.5, grain: 0.12 },
  },
  {
    id: "retro",
    label: "Retro tape",
    about: "A video tape: glitch cuts, scan lines, bright colour",
    script: [
      "Camera: steady moves, close and medium shots.",
      'Cuts: "cut" and "zoom_transition", with a tape glitch between scenes.',
    ],
    picture: "Soft bloom on the highlights",
    motion: "Steady camera move with a slight drift",
    transitions: { cut: "cut", fade: "glitch", dissolve: "glitch", zoom: "glitch" },
    stillMotion: 1,
    finish: { ...PLAIN, contrast: 1.05, saturate: 1.25, vignette: 0.25, grain: 0.06, scanlines: true },
  },
  {
    id: "dreamy",
    label: "Dreamy",
    about: "A floating camera, hazy light, soft blurs between scenes",
    script: [
      "Camera: slow floating moves, as if drifting through the scene.",
      'Cuts: "dissolve" and "fade"; actionLevel "low" or "medium".',
    ],
    picture: "Soft hazy light, a gentle glow on the highlights",
    motion: "Slow, floating camera, as if drifting",
    transitions: { cut: "dissolve", fade: "blur", dissolve: "dissolve", zoom: "blur" },
    stillMotion: 0.7,
    finish: { ...PLAIN, brightness: 1.04, contrast: 0.9, saturate: 1.05, vignette: 0.25 },
  },
];

export const EDIT_IDS = EDITS.map((e) => e.id) as [string, ...string[]];
export const editById = (id: string | undefined): Edit | undefined => EDITS.find((e) => e.id === id);
