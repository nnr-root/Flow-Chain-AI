"use client";
import { Player, type PlayerRef } from "@remotion/player";
import { MediaProvider } from "@src/media/remotion/media";
import type { RenderProps } from "@src/media/remotion/props";
import { Video } from "@src/media/remotion/Video";
import { type Ref, useCallback, useImperativeHandle, useMemo, useRef } from "react";

/** As in the studio's player: narration, music, and a sound per cut and for the hook need more than the Player's five audio tags. */
const MAX_AUDIO_TAGS = 16;

export type ShowcasePlayerHandle = {
  /** Plays from a frame; with `sound`, unmuted (only ever called from a visitor's own click, which a browser requires). */
  playFrom: (frame: number, sound?: boolean) => void;
};

/**
 * The paid render's own composition, playing in the visitor's browser: the same component the studio previews
 * with and the renderer films. It starts muted and looping (a browser lets nothing else start by itself); the
 * visitor has the sound and the timeline in the bar below.
 */
export default function ShowcasePlayer({ props, resolve, autoPlay, handle }: { props: RenderProps; resolve: (publishedPath: string) => string; autoPlay: boolean; handle?: Ref<ShowcasePlayerHandle> }) {
  const player = useRef<PlayerRef>(null);
  useImperativeHandle(handle, () => ({
    playFrom: (frame, sound) => {
      const p = player.current;
      if (!p) return;
      p.seekTo(frame);
      if (sound) p.unmute();
      p.play();
    },
  }), []);
  const Composition = useCallback(
    (p: RenderProps) => (
      <MediaProvider resolve={resolve}>
        <Video {...p} />
      </MediaProvider>
    ),
    [resolve],
  );
  const style = useMemo(() => ({ width: "100%", height: "100%" }), []);
  return (
    <Player
      ref={player}
      component={Composition}
      inputProps={props}
      durationInFrames={props.totalFrames}
      fps={props.fps}
      compositionWidth={props.width}
      compositionHeight={props.height}
      style={style}
      numberOfSharedAudioTags={MAX_AUDIO_TAGS}
      autoPlay={autoPlay}
      initiallyMuted
      loop
      controls
      clickToPlay
    />
  );
}
