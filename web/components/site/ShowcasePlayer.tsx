"use client";
import { Player, type PlayerRef } from "@remotion/player";
import { MediaProvider } from "@src/media/remotion/media";
import type { RenderProps } from "@src/media/remotion/props";
import { Video } from "@src/media/remotion/Video";
import { type Ref, type SyntheticEvent, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** As in the studio's player: narration, music, and a sound per cut and for the hook need more than the Player's five audio tags. */
const MAX_AUDIO_TAGS = 16;

export type ShowcasePlayerHandle = {
  /** Plays from a frame; with the click that asked for it, with sound (a browser lets sound start only from a visitor's own click). */
  playFrom: (frame: number, click?: SyntheticEvent) => void;
};

/**
 * The paid render's own composition, playing in the visitor's browser: the same component the studio previews
 * with and the renderer films. It starts muted and looping (a browser lets nothing else start by itself).
 *
 * Sound is not the muted Player unmuted. A Player that starts muted has no audio output, and making one later
 * rebuilds its audio tags under the sounds already playing: the voice and the music lose theirs and stay silent
 * for good. So the visitor's click swaps in a Player that has sound from its first frame, at the frame the
 * silent one had reached, and starts it inside that same click, which is what a browser asks for.
 */
export default function ShowcasePlayer({ props, resolve, autoPlay, handle }: { props: RenderProps; resolve: (publishedPath: string) => string; autoPlay: boolean; handle?: Ref<ShowcasePlayerHandle> }) {
  const player = useRef<PlayerRef>(null);
  const [sound, setSound] = useState<{ from: number } | null>(null);

  const withSound = useCallback((click: SyntheticEvent, frame?: number) => {
    const from = frame ?? player.current?.getCurrentFrame() ?? 0;
    // (at once, not after the click: the new Player must exist while the click still counts as the visitor's)
    flushSync(() => setSound({ from }));
    player.current?.seekTo(from);
    player.current?.play(click);
  }, []);

  useImperativeHandle(handle, () => ({
    playFrom: (frame, click) => {
      if (click && !sound) return withSound(click, frame);
      const p = player.current;
      if (!p) return;
      p.seekTo(frame);
      if (click) {
        p.unmute();
        p.play(click);
      } else p.play();
    },
  }), [sound, withSound]);

  // A video nobody can see is not played: the composition is drawn again for every frame, and two of them
  // running under a visitor who has scrolled on is what makes the rest of the page stutter on a slow machine.
  // One that was playing when it left carries on when it is back; one the visitor stopped stays stopped.
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    let interrupted = false;
    const seen = new IntersectionObserver(([entry]) => {
      const p = player.current;
      if (!p) return;
      if (!entry.isIntersecting && p.isPlaying()) {
        interrupted = true;
        p.pause();
      } else if (entry.isIntersecting && interrupted) {
        interrupted = false;
        p.play();
      }
    });
    seen.observe(node);
    return () => seen.disconnect();
  }, []);

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
    <div ref={frame} className="relative h-full w-full">
      <Player
        key={sound ? "sound" : "silent"}
        ref={player}
        component={Composition}
        inputProps={props}
        durationInFrames={props.totalFrames}
        fps={props.fps}
        compositionWidth={props.width}
        compositionHeight={props.height}
        style={style}
        numberOfSharedAudioTags={MAX_AUDIO_TAGS}
        autoPlay={sound ? false : autoPlay}
        initialFrame={sound?.from ?? 0}
        initiallyMuted={!sound}
        showVolumeControls={sound !== null}
        loop
        controls
        clickToPlay
        acknowledgeRemotionLicense
      />
      {!sound && (
        <button
          type="button" onClick={(e) => withSound(e)} data-testid="sound-on"
          className="absolute right-2.5 top-2.5 rounded-full bg-stage/75 px-3 py-1.5 text-[0.78rem] text-paper outline-offset-2 hover:bg-stage focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal"
        >
          Sound on
        </button>
      )}
    </div>
  );
}
