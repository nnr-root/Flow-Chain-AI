import type React from "react";
import { Composition } from "remotion";
import { COMPOSITION_ID, type RenderProps } from "./props.js";
import { CAPTION_STYLES } from "./styles.js";
import { Video } from "./Video.js";

/** Placeholder props for Remotion Studio; real renders always pass a full RenderProps. */
const DEFAULT_PROPS: RenderProps = {
  fps: 30,
  width: 1080,
  height: 1920,
  totalFrames: 1,
  scenes: [],
  boundaries: [],
  captions: { style: CAPTION_STYLES.hormozi, bottomPct: 30, pages: [] },
  hook: null,
  brand: null,
  audio: { narration: "narration.wav", bgm: null, speech: [], sfx: [] },
};

export const Root: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={Video}
    defaultProps={DEFAULT_PROPS}
    durationInFrames={1}
    fps={30}
    width={1080}
    height={1920}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.totalFrames,
      fps: props.fps,
      width: props.width,
      height: props.height,
    })}
  />
);
