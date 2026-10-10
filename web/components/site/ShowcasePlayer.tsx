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
  /** Plays from a frame; with the click that asked for it, so that it may be heard. */
  playFrom: (frame: number, click?: SyntheticEvent) => void;
};

/**
 * Whether the visitor has touched the page yet. A browser lets a page make sound only after that, so it is the
 * one thing that decides whether a video can be heard; it is the same for every player on the page.
 */
let touched = false;
const waiting = new Set<(click: Event) => void>();
function onFirstTouch(heard: (click: Event) => void): () => void {
  if (waiting.size === 0 && !touched) {
    const first = (e: Event) => {
      touched = true;
      window.removeEventListener("click", first, true);
      window.removeEventListener("keydown", first, true);
      for (const tell of [...waiting]) tell(e);
      waiting.clear();
    };
    // (a click or a key, which every browser counts as the visitor's own act; a scroll or a hover is not one)
    window.addEventListener("click", first, true);
    window.addEventListener("keydown", first, true);
  }
  waiting.add(heard);
  return () => void waiting.delete(heard);
}

/**
 * The paid render's own composition, playing in the visitor's browser: the same component the studio previews
 * with and the renderer films.
 *
 * A video here has its sound on. A browser does not let a page be heard before the visitor has touched it, so
 * until then it plays silently, and with the first click or key anywhere on the page it is heard, from where it
 * had got to: there is nothing to find and press. After that the bar under the video has the volume.
 *
 * The silent video is not unmuted; another Player takes its place. A Player that starts muted has no audio
 * output, and making one later rebuilds its audio tags under the sounds already playing: the voice and the
 * music lose theirs and stay silent for good. The swap is done inside the visitor's click, where a browser
 * allows sound to start.
 */
export default function ShowcasePlayer({ props, resolve, autoPlay, handle }: { props: RenderProps; resolve: (publishedPath: string) => string; autoPlay: boolean; handle?: Ref<ShowcasePlayerHandle> }) {
  const player = useRef<PlayerRef>(null);
  // a player that comes to the page after the visitor's first touch has its sound from the start
  const [sound, setSound] = useState<{ from: number } | null>(() => (touched ? { from: 0 } : null));
  const frame = useRef<HTMLDivElement>(null);
  const inView = useRef(false);
  /** Whether it should be playing when it can be seen: it started by itself, or the visitor started it, and has not stopped it. */
  const wanted = useRef(autoPlay);
  /** A pause of the page's own doing (the video left the window), which is not the visitor stopping it. */
  const ours = useRef(false);

  const withSound = useCallback((click: Event | SyntheticEvent, frameAt?: number, play?: boolean) => {
    const from = frameAt ?? player.current?.getCurrentFrame() ?? 0;
    // (at once, not after the click: the new Player must exist while the click still counts as the visitor's)
    flushSync(() => setSound({ from }));
    player.current?.seekTo(from);
    if (play ?? (wanted.current && inView.current)) player.current?.play(click as SyntheticEvent);
  }, []);

  useEffect(() => {
    if (sound) return;
    return onFirstTouch((click) => withSound(click));
  }, [sound, withSound]);

  useImperativeHandle(handle, () => ({
    playFrom: (at, click) => {
      wanted.current = true;
      if (click && !sound) return withSound(click, at, true);
      const p = player.current;
      if (!p) return;
      p.seekTo(at);
      p.play(click);
    },
  }), [sound, withSound]);

  // what the visitor does with the bar is remembered: a video they stopped is not started again behind their back
  useEffect(() => {
    const p = player.current;
    if (!p) return;
    const played = () => { wanted.current = true; };
    const paused = () => {
      if (ours.current) ours.current = false;
      else wanted.current = false;
    };
    p.addEventListener("play", played);
    p.addEventListener("pause", paused);
    return () => {
      p.removeEventListener("play", played);
      p.removeEventListener("pause", paused);
    };
  }, [sound]);

  // A video nobody can see is not played: the composition is drawn again for every frame, and two of them
  // running under a visitor who has scrolled on is what makes the rest of the page stutter on a slow machine.
  // (It also means two videos are never heard at once.)
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const seen = new IntersectionObserver(([entry]) => {
      // A sixth of it showing is enough to be watched: on a short screen the video under the page's opening words
      // shows no more than that at first, and one that stood still there would look broken. (The share is read
      // from the entry itself: browsers do not agree on what "intersecting" means below the first threshold.)
      const showing = entry.intersectionRatio >= 0.15;
      inView.current = showing;
      const p = player.current;
      if (!p) return;
      if (!showing && p.isPlaying()) {
        ours.current = true;
        p.pause();
      } else if (showing && wanted.current && !p.isPlaying()) p.play();
    }, { threshold: [0, 0.15] });
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
    <div ref={frame} className="relative h-full w-full" data-sound={sound !== null}>
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
        // the silent one starts by itself; the one with sound is started inside the click that brought it
        autoPlay={sound ? false : autoPlay}
        initialFrame={sound?.from ?? 0}
        initiallyMuted={!sound}
        showVolumeControls={sound !== null}
        loop
        controls
        clickToPlay
        acknowledgeRemotionLicense
      />
    </div>
  );
}
