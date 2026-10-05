import type React from "react";
import { Audio, Sequence, staticFile } from "remotion";
import type { RenderProps } from "../props.js";
import { duckVolume, fadeOutVolume } from "../timeline.js";

/**
 * Narration is one sample-exact WAV from frame 0 (per-scene audio would snap each start to a frame and click).
 * BGM loops under it: ducked inside speech, faded out at the end (curves follow the video's frame, not the loop's).
 * Sound effects start at their cue frames; they neither duck nor are ducked.
 */
export const AudioLayer: React.FC<{ audio: RenderProps["audio"]; totalFrames: number }> = ({ audio, totalFrames }) => {
  const { bgm, speech } = audio;
  return (
    <>
      <Audio src={staticFile(audio.narration)} />
      {audio.sfx.map((cue, i) => (
        <Sequence key={i} from={cue.frame} name={`sfx ${i + 1}`}>
          <Audio src={staticFile(cue.src)} volume={cue.gain} />
        </Sequence>
      ))}
      {bgm && (
        <Audio
          src={staticFile(bgm.src)}
          loop
          // "repeat" (the default) restarts the frame passed to `volume` on every loop, which would evaluate the duck and
          // fade-out curves (absolute video frames) against the wrong frame whenever the BGM is shorter than the video.
          loopVolumeCurveBehavior="extend"
          volume={(f) =>
            bgm.gain * duckVolume(f, speech, bgm.duckTo, bgm.rampFrames) * fadeOutVolume(f, totalFrames, bgm.fadeOutFrames)
          }
        />
      )}
    </>
  );
};
