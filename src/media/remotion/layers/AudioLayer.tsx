import type React from "react";
import { Audio, Sequence, useVideoConfig } from "remotion";
import { useMedia } from "../media.js";
import type { RenderProps } from "../props.js";
import { duckVolume, fadeOutVolume, framesAt, SOUND_MIX, sceneSoundVolume } from "../timeline.js";

/**
 * Narration is one sample-exact WAV from frame 0 (per-scene audio would snap each start to a frame and click).
 * BGM loops under it: ducked inside speech, faded out at the end (curves follow the video's frame, not the loop's).
 * Each scene's own sound plays on that scene's frames, faded at the scene's cuts and ducked while the narration speaks
 * (phase 14). Narration comes first: the sounds sit under it.
 */
export const AudioLayer: React.FC<{ audio: RenderProps["audio"]; totalFrames: number }> = ({ audio, totalFrames }) => {
  const { bgm, speech } = audio;
  const media = useMedia();
  const { fps } = useVideoConfig();
  const ramp = framesAt(SOUND_MIX.rampFrames, fps);
  const fade = framesAt(SOUND_MIX.fadeFrames, fps);
  return (
    <>
      <Audio src={media(audio.narration)} />
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
      {audio.sound.map((entry) => (
        // the volume callback's frame is local to the Sequence; the duck is read on the video's own frame
        <Sequence key={`${entry.src}@${entry.from}`} from={entry.from} durationInFrames={entry.frames} layout="none">
          <Audio
            src={media(entry.src)}
            volume={(f) => sceneSoundVolume(f, entry.frames, fade, speech, SOUND_MIX.duckTo, ramp, entry.gain, entry.from)}
          />
        </Sequence>
      ))}
    </>
  );
};
