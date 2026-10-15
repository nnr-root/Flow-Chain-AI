import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { FinishProps } from "../props.js";
import { finishFilter, grainOffset } from "../timeline.js";

// A tile of grey noise, drawn by the browser that renders: no file to ship, the same on every render.
const NOISE = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
)}")`;

/** The picture under an edit's grade (phase 8 spec §3); without a finish, the picture as it is. */
export const Graded: React.FC<{ finish?: FinishProps; children: React.ReactNode }> = ({ finish, children }) => {
  const filter = finish ? finishFilter(finish) : undefined;
  return filter ? <AbsoluteFill style={{ filter }}>{children}</AbsoluteFill> : <>{children}</>;
};

/** What an edit lays over the picture: a vignette, moving grain, a tape's scan lines. Under the captions. */
export const FinishLayer: React.FC<{ finish: FinishProps }> = ({ finish }) => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const at = grainOffset(frame);
  const gap = Math.max(3, Math.round(height / 480));
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {finish.vignette > 0 && (
        <AbsoluteFill style={{ background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,${finish.vignette}) 100%)` }} />
      )}
      {finish.grain > 0 && (
        <AbsoluteFill style={{ backgroundImage: NOISE, backgroundPosition: `${at.x}px ${at.y}px`, mixBlendMode: "overlay", opacity: Math.min(1, finish.grain * 3) }} />
      )}
      {finish.scanlines && (
        <AbsoluteFill style={{ background: `repeating-linear-gradient(to bottom, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) ${gap / 2}px, rgba(0,0,0,0) ${gap / 2}px, rgba(0,0,0,0) ${gap}px)` }} />
      )}
    </AbsoluteFill>
  );
};
