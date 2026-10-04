import type React from "react";
import { Audio, staticFile } from "remotion";
import type { RenderProps } from "../props.js";
import { duckVolume, fadeOutVolume } from "../timeline.js";

/**
 * Narration is one sample-exact WAV from frame 0 (per-scene audio would snap each start to a frame and click).
 * BGM loops under it: ducked inside speech, faded out at the end.
 */
export const AudioLayer: React.FC<{ audio: RenderProps["audio"]; totalFrames: number }> = ({ audio, totalFrames }) => {
  const { bgm, speech } = audio;
  return (
    <>
      <Audio src={staticFile(audio.narration)} />
      {bgm && (
        <Audio
          src={staticFile(bgm.src)}
          loop
          volume={(f) =>
            bgm.gain * duckVolume(f, speech, bgm.duckTo, bgm.rampFrames) * fadeOutVolume(f, totalFrames, bgm.fadeOutFrames)
          }
        />
      )}
    </>
  );
};
