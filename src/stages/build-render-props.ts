import { extname, join } from "node:path";
import type { Caption } from "@remotion/captions";
import type { Size } from "../config.js";
import type { Manifest } from "../manifest/schema.js";
import { captionPages } from "../media/remotion/caption-pages.js";
import type { Boundary, RenderProps, SceneProps } from "../media/remotion/props.js";
import { CAPTION_STYLES, captionBottomPct } from "../media/remotion/styles.js";
import { halfWindowFor, speechRanges } from "../media/remotion/timeline.js";
import { globalWords } from "./captions.js";
import { paths } from "./paths.js";
import { requireFitted, requireScript } from "./require.js";
import { needsKeyframe, sceneFrames } from "./visual.js";

/** BGM mix constants (spec §4.4): ducked to 18 % under speech with 6-frame ramps, 1 s fade-out. */
export const BGM_MIX = { duckTo: 0.18, rampFrames: 6, fadeOutFrames: 30 } as const;

export type RenderInputs = {
  props: RenderProps;
  /** Published path (as used in props) → absolute source file, for staging. */
  files: Record<string, string>;
};

/**
 * The only bridge from the manifest to the Remotion composition: a pure function of the manifest, the
 * output format and the captions file. Every frame number in the result follows Phase 1's rules.
 */
export function buildRenderProps(
  m: Manifest,
  opts: { dir: string; fontsDir: string; fps: number; size: Size },
  captions: Caption[],
): RenderInputs {
  const { fps, size } = opts;
  const script = requireScript(m);
  const frames = sceneFrames(m, fps);
  const totalFrames = frames.reduce((a, b) => a + b, 0);
  const files: Record<string, string> = {};
  const publish = (rel: string, abs: string) => {
    files[rel] = abs;
    return rel;
  };

  let from = 0;
  const scenes: SceneProps[] = m.scenes.map((s, i) => {
    const scene: SceneProps =
      s.mode === 1
        ? { kind: "video", src: publish(requireFitted(s).path, join(opts.dir, requireFitted(s).path)), from, frames: frames[i] }
        : {
            kind: "still",
            src: publish(paths.keyframe(i), join(opts.dir, paths.keyframe(i))),
            camera: script.scenes[i].camera,
            from,
            frames: frames[i],
          };
    from += frames[i];
    return scene;
  });

  const boundaries: Boundary[] = scenes.slice(1).map((scene, j) => {
    const k = j + 1;
    const seam = m.scenes[k].mode === 1 && !needsKeyframe(m, k);
    const transition = seam ? "cut" : m.request.render.transition;
    return {
      frame: scene.from,
      kind: seam ? "seam" : "cut",
      transition,
      halfWindow: seam ? 0 : halfWindowFor(transition, frames[k - 1], frames[k]),
    };
  });

  const style = CAPTION_STYLES[m.request.render.captionStyle];
  publish(style.font.file, join(opts.fontsDir, style.font.file));
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
      captions: { style, bottomPct: captionBottomPct(size.width, size.height), pages: captionPages(captions) },
      audio: {
        narration: publish(paths.narration, join(opts.dir, paths.narration)),
        bgm,
        speech: speechRanges(globalWords(m), fps, totalFrames),
      },
    },
    files,
  };
}
