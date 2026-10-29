import type React from "react";
import { Audio, Sequence, useVideoConfig } from "remotion";
import { useMedia } from "../media.js";
import type { RenderProps } from "../props.js";
import { bedVolume, duckVolume, fadeOutVolume } from "../timeline.js";

/**
 * Narration is one sample-exact WAV from frame 0 (per-scene audio would snap each start to a frame and click).
 * BGM loops under it: ducked inside speech, faded out at the end (curves follow the video's frame, not the loop's).
 * Sound effects start at their cue frames; they neither duck nor are ducked. A hit is mounted for two seconds,
 * longer than any of them lasts (the longest is 1.9 s): mounted to the end of the video, a long video's hundreds
 * of cuts would each hold an audio tag at once, and a player has only so many. A bed (a texture under a whole
 * scene) loops for the scene's length and fades in and out at its ends.
 */
export const AudioLayer: React.FC<{ audio: RenderProps["audio"]; totalFrames: number }> = ({ audio, totalFrames }) => {
  const { bgm, speech } = audio;
  const media = useMedia();
  const { fps } = useVideoConfig();
  return (
    <>
      <Audio src={media(audio.narration)} />
      {audio.sfx.map((cue, i) =>
        cue.durationFrames ? (
          <Sequence key={i} from={cue.frame} durationInFrames={cue.durationFrames} layout="none" name={`sfx ${i + 1}`}>
            {/* the volume curve gets the frame inside this Sequence; "extend" keeps it running across loops */}
            <Audio src={media(cue.src)} loop loopVolumeCurveBehavior="extend" volume={(f) => cue.gain * bedVolume(f, cue.durationFrames!, cue.fadeFrames ?? 0)} />
          </Sequence>
        ) : (
          <Sequence key={i} from={cue.frame} durationInFrames={fps * 2} layout="none" name={`sfx ${i + 1}`}>
            <Audio src={media(cue.src)} volume={cue.gain} />
          </Sequence>
        ),
      )}
      {bgm && (
        <Audio
          src={media(bgm.src)}
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
