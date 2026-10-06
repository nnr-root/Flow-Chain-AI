import { extname, join } from "node:path";
import type { Caption } from "@remotion/captions";
import type { Size } from "../config.js";
import type { Manifest } from "../manifest/schema.js";
import { captionPages, type TimedWord } from "../media/remotion/caption-pages.js";
import { SFX, sfxCues } from "../media/sfx.js";
import type { Boundary, RenderProps, SceneProps } from "../media/remotion/props.js";
import { captionBottomPct } from "../media/remotion/styles.js";
import { HOOK, halfWindowFor, speechRanges } from "../media/remotion/timeline.js";
import { globalWords } from "./captions.js";
import { captionStyleFor, hookTextFor, transitionInto } from "./look.js";
import { paths } from "./paths.js";
import { requireFitted, requireScript } from "./require.js";
import { needsKeyframe, sceneFrames } from "./visual.js";

/** BGM mix constants (2.3 spec §5.4): ducked to 40 % under speech with 10-frame S-curve ramps, 1 s fade-out. */
export const BGM_MIX = { duckTo: 0.4, rampFrames: 10, fadeOutFrames: 30 } as const;

export type RenderInputs = {
  props: RenderProps;
  /** Published path (as used in props) → absolute source file, for staging. */
  files: Record<string, string>;
};

/** What differs between a real render and a draft preview: where pictures, timings, words and narration come from. */
export type RenderParts = {
  /** Frames per scene. */
  frames: number[];
  /** Scene i's picture; `publish` registers a file and returns its published path. */
  scene: (i: number, from: number, frames: number, publish: (rel: string, abs: string) => string) => SceneProps;
  /** Every spoken word on the video's clock (the music ducks under them). */
  words: TimedWord[];
  captions: Caption[];
  narration: { rel: string; abs: string };
};

export type RenderPropsOptions = {
  dir: string;
  fontsDir: string;
  sfxDir: string;
  fps: number;
  size: Size;
  /** Where the brand look's files are; the run directory unless a kit is only being previewed. */
  brandDir?: string;
};

/**
 * The only bridge from the manifest to the Remotion composition: a pure function of the manifest, the
 * output format and the captions file. Every frame number in the result follows Phase 1's rules.
 */
export function buildRenderProps(m: Manifest, opts: RenderPropsOptions, captions: Caption[]): RenderInputs {
  const script = requireScript(m);
  return assembleRenderProps(m, opts, {
    frames: sceneFrames(m, opts.fps),
    scene: (i, from, frames, publish) => {
      const s = m.scenes[i];
      return s.mode === 1
        ? { kind: "video", src: publish(requireFitted(s).path, join(opts.dir, requireFitted(s).path)), from, frames }
        : {
            kind: "still",
            src: publish(paths.keyframe(i), join(opts.dir, paths.keyframe(i))),
            camera: script.scenes[i].camera,
            from,
            frames,
          };
    },
    words: globalWords(m),
    captions,
    narration: { rel: paths.narration, abs: join(opts.dir, paths.narration) },
  });
}

/** Lays the parts out as RenderProps; shared by the render and the studio's draft preview so they cannot diverge. */
export function assembleRenderProps(m: Manifest, opts: RenderPropsOptions, parts: RenderParts): RenderInputs {
  const { fps, size } = opts;
  const { frames } = parts;
  const totalFrames = frames.reduce((a, b) => a + b, 0);
  const files: Record<string, string> = {};
  const publish = (rel: string, abs: string) => {
    files[rel] = abs;
    return rel;
  };

  let from = 0;
  const scenes: SceneProps[] = m.scenes.map((_s, i) => {
    const scene = parts.scene(i, from, frames[i], publish);
    from += frames[i];
    return scene;
  });

  const boundaries: Boundary[] = scenes.slice(1).map((scene, j) => {
    const k = j + 1;
    const seam = m.scenes[k].mode === 1 && !needsKeyframe(m, k);
    const transition = seam ? "cut" : transitionInto(m, k);
    return {
      frame: scene.from,
      kind: seam ? "seam" : "cut",
      transition,
      halfWindow: seam ? 0 : halfWindowFor(transition, frames[k - 1], frames[k]),
    };
  });

  const hookText = hookTextFor(m);
  const hook = hookText
    ? {
        text: hookText,
        endFrame: Math.min(Math.round(HOOK.seconds * fps), frames[0]),
        zoomFrom: HOOK.zoomFrom,
        zoomFrames: HOOK.zoomFrames,
      }
    : null;

  const style = captionStyleFor(m);
  // a brand font lives in the run directory; every other font is bundled
  const brandDir = opts.brandDir ?? opts.dir;
  publish(style.font.file, join(m.request.render.brand?.font ? brandDir : opts.fontsDir, style.font.file));
  const look = m.request.render.brand;
  const brand = look ? { logo: publish(look.logo, join(brandDir, look.logo)), ...look.watermark } : null;
  const bgm = m.request.bgm
    ? { src: publish(`bgm${extname(m.request.bgm)}`, m.request.bgm), gain: m.request.render.bgmGain, ...BGM_MIX }
    : null;

  return {
    props: {
      fps,
      width: size.width,
      height: size.height,
      totalFrames,
      scenes,
      boundaries,
      captions: { style, bottomPct: captionBottomPct(size.width, size.height), pages: captionPages(parts.captions) },
      hook,
      brand,
      audio: {
        narration: publish(parts.narration.rel, parts.narration.abs),
        bgm,
        speech: speechRanges(parts.words, fps, totalFrames),
        sfx: m.request.render.sfx
          ? sfxCues(boundaries, { hook: hook !== null, gain: m.request.render.sfxGain }).map((c) => ({
              src: publish(`sfx/${SFX[c.sound].file}`, join(opts.sfxDir, SFX[c.sound].file)),
              frame: c.frame,
              gain: c.gain,
            }))
          : [],
      },
    },
    files,
  };
}
