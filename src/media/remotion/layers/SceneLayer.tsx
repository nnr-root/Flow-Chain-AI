import type React from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, useCurrentFrame } from "remotion";
import { useMedia } from "../media.js";
import type { CameraMove, SceneProps } from "../props.js";
import { kenBurnsTransform } from "../timeline.js";

const FILL: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };

/** Mode 2: a still keyframe moved by a Ken Burns camera (sub-pixel CSS transform, no oversampling needed). */
export const KenBurns: React.FC<{ src: string; camera: CameraMove; frames: number }> = ({ src, camera, frames }) => {
  const frame = useCurrentFrame();
  const media = useMedia();
  const t = kenBurnsTransform(camera, frame, frames);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img src={media(src)} style={{ ...FILL, transform: `scale(${t.scale}) translate(${t.xPct}%, ${t.yPct}%)` }} />
    </AbsoluteFill>
  );
};

/** One scene's picture at the current (sequence-relative) frame. */
export const SceneVisual: React.FC<{ scene: SceneProps }> = ({ scene }) => {
  const media = useMedia();
  return scene.kind === "video" ? (
    <AbsoluteFill>
      <OffthreadVideo src={media(scene.src)} muted style={FILL} />
    </AbsoluteFill>
  ) : (
    <KenBurns src={scene.src} camera={scene.camera} frames={scene.frames} />
  );
};

/** Every scene in its own sequence: scene k occupies frames [from, from + frames). */
export const SceneLayer: React.FC<{ scenes: SceneProps[] }> = ({ scenes }) => (
  <AbsoluteFill style={{ backgroundColor: "black" }}>
    {scenes.map((scene, i) => (
      <Sequence key={i} from={scene.from} durationInFrames={scene.frames} name={`scene ${i + 1}`}>
        <SceneVisual scene={scene} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
