import type { Manifest } from "../manifest/schema.js";
import { wordsToCaptions } from "../media/remotion/caption-pages.js";
import { sceneFrameCounts } from "../media/timeline.js";
import { applyRenderOptions, type RerenderFlags } from "../rerender.js";
import {
  assembleRenderProps, buildRenderProps, type RenderInputs, type RenderPropsOptions,
} from "../stages/build-render-props.js";
import { globalWords } from "../stages/captions.js";
import { captionStyleFor } from "../stages/look.js";
import { requireScript } from "../stages/require.js";
import { draftDurations, draftWords } from "./draft.js";
import { DRAFT_FILES, VIRTUAL } from "./draft-media.js";

/** The look flags a preview may carry: exactly what `rerender` accepts. */
export type LookFlags = RerenderFlags;

/** A copy of the run with pending look changes applied, as `rerender` would store them; the run itself is untouched. */
export function withLook(m: Manifest, flags: LookFlags = {}): Manifest {
  const copy = structuredClone(m);
  applyRenderOptions(copy, flags);
  return copy;
}

/**
 * Player props for a run whose media exists, with pending look changes: the functions `rerender` and the
 * captions and render stages use, in the same order, so the preview is what a re-render will produce.
 */
export function previewProps(m: Manifest, opts: RenderPropsOptions, flags: LookFlags = {}): RenderInputs {
  const look = withLook(m, flags);
  return buildRenderProps(look, opts, wordsToCaptions(globalWords(look), captionStyleFor(look).maxWordsPerPage));
}

/**
 * Player props for a run that has only a script: placeholder pictures, estimated lengths and a silent
 * narration; captions, hook, transitions, brand, music and sound effects are the real ones.
 */
export function buildDraftProps(m: Manifest, opts: RenderPropsOptions, flags: LookFlags = {}): RenderInputs {
  const look = withLook(m, flags);
  const script = requireScript(look);
  const words = draftWords(look);
  return assembleRenderProps(look, opts, {
    frames: sceneFrameCounts(draftDurations(look), opts.fps),
    scene: (i, from, frames, publish) => ({
      kind: "still",
      src: publish(DRAFT_FILES.scene(i), `${VIRTUAL}scene:${i}`),
      camera: script.scenes[i].camera,
      from,
      frames,
    }),
    words,
    captions: wordsToCaptions(words, captionStyleFor(look).maxWordsPerPage),
    narration: { rel: DRAFT_FILES.silence, abs: `${VIRTUAL}silence` },
  });
}
