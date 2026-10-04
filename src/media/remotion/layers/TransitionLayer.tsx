import type React from "react";
import { AbsoluteFill, Freeze, Sequence, useCurrentFrame } from "remotion";
import type { Boundary, SceneProps } from "../props.js";
import { glitchLook, type LayerLook, transitionLook } from "../timeline.js";
import { SceneVisual } from "./SceneLayer.js";

const layerStyle = (look: LayerLook): React.CSSProperties => ({
  opacity: look.opacity,
  filter: look.blurPx > 0 ? `blur(${look.blurPx}px)` : undefined,
  transform: look.scale !== 1 ? `scale(${look.scale})` : undefined,
});

/** A scene shown at a fixed frame of its own sequence (Freeze also pins video and Ken Burns time). */
const ShownAt: React.FC<{ scene: SceneProps; frame: number }> = ({ scene, frame }) => (
  <Freeze frame={frame}>
    <SceneVisual scene={scene} />
  </Freeze>
);

/** Horizontal slices shifted sideways plus a colour-fringe copy: the visible scene "glitches" for a few frames. */
const Glitched: React.FC<{ children: React.ReactNode; boundaryIndex: number; local: number }> = ({
  children,
  boundaryIndex,
  local,
}) => {
  const look = glitchLook(boundaryIndex, local);
  return (
    <AbsoluteFill>
      {look.slices.map((s, i) => (
        <AbsoluteFill
          key={i}
          style={{
            clipPath: `inset(${s.topPct}% 0 ${100 - s.topPct - s.heightPct}% 0)`,
            transform: `translateX(${s.dxPct}%)`,
          }}
        >
          {children}
        </AbsoluteFill>
      ))}
      <AbsoluteFill
        style={{ mixBlendMode: "screen", opacity: 0.35, transform: `translateX(${look.channelShiftPct}%)`, filter: "hue-rotate(160deg)" }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Window: React.FC<{ prev: SceneProps; next: SceneProps; boundary: Boundary; index: number }> = ({
  prev,
  next,
  boundary,
  index,
}) => {
  const local = useCurrentFrame();
  const h = boundary.halfWindow;
  const look = transitionLook(boundary.transition, local, h);
  // A plays its last h frames, then holds its last frame; B holds its first frame, then plays.
  const aFrame = Math.min(prev.frames - h + local, prev.frames - 1);
  const bFrame = Math.max(local - h, 0);
  const content = (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {look.a && (
        <AbsoluteFill style={layerStyle(look.a)}>
          <ShownAt scene={prev} frame={aFrame} />
        </AbsoluteFill>
      )}
      {look.b && (
        <AbsoluteFill style={layerStyle(look.b)}>
          <ShownAt scene={next} frame={bFrame} />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
  return look.glitch ? (
    <Glitched boundaryIndex={index} local={local}>
      {content}
    </Glitched>
  ) : (
    content
  );
};

/**
 * Overlay transitions: nothing is drawn outside windows, and windows never move a scene, the audio or the
 * captions. Seams (and `cut`) have halfWindow 0 and get no window at all.
 */
export const TransitionLayer: React.FC<{ scenes: SceneProps[]; boundaries: Boundary[] }> = ({ scenes, boundaries }) => (
  <AbsoluteFill>
    {boundaries.map((b, i) =>
      b.halfWindow > 0 ? (
        <Sequence key={i} from={b.frame - b.halfWindow} durationInFrames={2 * b.halfWindow} name={`transition ${i + 1}`}>
          <Window prev={scenes[i]} next={scenes[i + 1]} boundary={b} index={i} />
        </Sequence>
      ) : null,
    )}
  </AbsoluteFill>
);
