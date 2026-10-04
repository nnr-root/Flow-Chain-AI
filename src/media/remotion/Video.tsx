import type React from "react";
import { AbsoluteFill } from "remotion";
import { AudioLayer } from "./layers/AudioLayer.js";
import { Captions } from "./layers/Captions.js";
import { SceneLayer } from "./layers/SceneLayer.js";
import { TransitionLayer } from "./layers/TransitionLayer.js";
import type { RenderProps } from "./props.js";

/** Layer stack, bottom to top. 2.3 adds HookLayer and BrandLayer between Captions and AudioLayer. */
export const Video: React.FC<RenderProps> = (props) => (
  <AbsoluteFill style={{ backgroundColor: "black" }}>
    <SceneLayer scenes={props.scenes} />
    <TransitionLayer scenes={props.scenes} boundaries={props.boundaries} />
    <Captions style={props.captions.style} bottomPct={props.captions.bottomPct} pages={props.captions.pages} />
    <AudioLayer audio={props.audio} totalFrames={props.totalFrames} />
  </AbsoluteFill>
);
