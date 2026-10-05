import type React from "react";
import { AbsoluteFill } from "remotion";
import { AudioLayer } from "./layers/AudioLayer.js";
import { BrandLayer } from "./layers/BrandLayer.js";
import { Captions } from "./layers/Captions.js";
import { HookLayer, SnapZoom } from "./layers/HookLayer.js";
import { SceneLayer } from "./layers/SceneLayer.js";
import { TransitionLayer } from "./layers/TransitionLayer.js";
import type { RenderProps } from "./props.js";

/** Layer stack, bottom to top. The snap zoom moves only the picture, never the captions or the hook title. */
export const Video: React.FC<RenderProps> = (props) => (
  <AbsoluteFill style={{ backgroundColor: "black" }}>
    <SnapZoom hook={props.hook}>
      <SceneLayer scenes={props.scenes} />
      <TransitionLayer scenes={props.scenes} boundaries={props.boundaries} />
    </SnapZoom>
    <Captions style={props.captions.style} bottomPct={props.captions.bottomPct} pages={props.captions.pages} />
    {props.hook && <HookLayer hook={props.hook} style={props.captions.style} />}
    {props.brand && <BrandLayer brand={props.brand} />}
    <AudioLayer audio={props.audio} totalFrames={props.totalFrames} />
  </AbsoluteFill>
);
