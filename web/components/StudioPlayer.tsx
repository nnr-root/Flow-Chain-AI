"use client";
import { Player, type PlayerRef } from "@remotion/player";
import { MediaProvider } from "@src/media/remotion/media";
import type { RenderProps } from "@src/media/remotion/props";
import { Video } from "@src/media/remotion/Video";
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from "react";

export type StudioPlayerHandle = { seekTo: (frame: number) => void };

type Props = {
  props: RenderProps;
  /** Maps a published path from the props to a URL. A new function reloads the media (after a reroll, a new look). */
  resolve: (publishedPath: string) => string;
  className?: string;
};

/** The paid render's own composition, mounted in the browser: same component, same props, other file URLs. */
export const StudioPlayer = forwardRef<StudioPlayerHandle, Props>(function StudioPlayer({ props, resolve, className }, ref) {
  const player = useRef<PlayerRef>(null);
  useImperativeHandle(ref, () => ({ seekTo: (frame) => player.current?.seekTo(frame) }), []);
  const Composition = useCallback(
    (p: RenderProps) => (
      <MediaProvider resolve={resolve}>
        <Video {...p} />
      </MediaProvider>
    ),
    [resolve],
  );
  const style = useMemo(() => ({ width: "100%", aspectRatio: `${props.width} / ${props.height}` }), [props.width, props.height]);
  return (
    <div className={className} data-testid="player" data-total-frames={props.totalFrames}>
      <Player
        ref={player}
        component={Composition}
        inputProps={props}
        durationInFrames={props.totalFrames}
        fps={props.fps}
        compositionWidth={props.width}
        compositionHeight={props.height}
        style={style}
        controls
        clickToPlay
        spaceKeyToPlayOrPause
      />
    </div>
  );
});
