"use client";
import { motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { inCredits } from "@/lib/credit";
import { type Controls, madeControls, mediaUrl, restyle } from "@/lib/site/restyle";
import { SHOW_EVENT, type Showcase } from "@/lib/site/showcases";
import type { ShowcasePlayerHandle } from "./ShowcasePlayer";
import { Stage } from "./Stage";

// the player and the composition are the heavy part of the page: fetched after the poster is on screen
const ShowcasePlayer = dynamic(() => import("./ShowcasePlayer"), { ssr: false });

/** The one spring the controls move with (Phase 4 spec §3.4, "snap"). */
const SNAP = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;

const CAPTIONS: Array<[Controls["captions"], string]> = [["preset", "Matched"], ["hormozi", "Punchy"], ["mrbeast", "Playful"], ["minimalist", "Quiet"]];
const CUTS: Array<[Controls["cuts"], string]> = [["auto", "As scripted"], ["cut", "Hard cut"], ["fade", "Fade"], ["dissolve", "Dissolve"], ["blur", "Blur"], ["zoom", "Zoom"], ["glitch", "Glitch"]];

/** A row of choices where one is on; the mark under it slides to the one chosen. */
function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: Array<[T, string]>; value: T; onChange: (v: T) => void }) {
  const group = useId();
  return (
    <fieldset>
      <legend className="text-[0.9rem] font-bold">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-1.5">
        {options.map(([id, name]) => (
          <label key={id} className="relative cursor-pointer rounded-full px-3 py-1 text-[0.95rem] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal">
            <input type="radio" name={group} value={id} checked={value === id} onChange={() => onChange(id)} className="sr-only" />
            {/* the highlighter, which slides to the one chosen */}
            {value === id && <motion.span layoutId={`${group}-mark`} transition={SNAP} className="absolute inset-0 rounded-full bg-marker" />}
            <span className={`relative ${value === id ? "font-bold text-paper" : "text-graphite hover:text-ink"}`}>{name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 whitespace-nowrap text-[0.95rem]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden="true" className="relative h-[1.15rem] w-8 shrink-0 rounded-full bg-ink/20 transition-colors peer-checked:bg-signal peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal">
        <motion.span animate={{ x: checked ? 14 : 0 }} transition={SNAP} className="absolute left-[3px] top-[3px] h-3 w-3 rounded-full bg-paper" />
      </span>
      {label}
    </label>
  );
}

/** A video waiting at the side of the one that is playing: its frame, dimmed; a click brings it to the front. */
function Side({ showcase, onPick }: { showcase: Showcase; onPick: (slug: string) => void }) {
  return (
    <button
      type="button" onClick={() => onPick(showcase.slug)} data-testid={`wall-${showcase.slug}`} aria-label={`Play “${showcase.receipt.title}”`}
      className="relative hidden aspect-[9/16] w-[11.5rem] shrink overflow-hidden rounded-[22px] opacity-45 ring-1 ring-hairline transition-[opacity,transform] duration-300 hover:scale-[1.03] hover:opacity-90 md:block"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/showcase/${showcase.slug}/poster.jpg`} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
    </button>
  );
}

/**
 * The hero: the page's words (`children`) beside the Stage with a real video in the real renderer, and under
 * both the controls that restyle it (Phase 4 spec §6). The poster is on screen first; the player takes its place
 * once it is fetched and the Stage is in view.
 */
export function LiveStage({ showcases, title, children }: { showcases: Showcase[]; title: React.ReactNode; children: React.ReactNode }) {
  const [slug, setSlug] = useState(showcases[0].slug);
  const showcase = showcases.find((s) => s.slug === slug) ?? showcases[0];
  const [controls, setControls] = useState<Controls>(() => madeControls(showcase.looks));
  const [live, setLive] = useState(false);
  const still = useReducedMotion() ?? false;
  const frame = useRef<HTMLDivElement>(null);
  const player = useRef<ShowcasePlayerHandle>(null);

  // not before the page has painted and the Stage is actually looked at
  useEffect(() => {
    const node = frame.current;
    if (!node || live) return;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setLive(true);
        seen.disconnect();
      }
    }, { rootMargin: "120px" });
    const idle = window.setTimeout(() => seen.observe(node), 250);
    return () => {
      window.clearTimeout(idle);
      seen.disconnect();
    };
  }, [live]);

  const choose = useCallback((next: string) => {
    const to = showcases.find((s) => s.slug === next);
    if (!to) return;
    setSlug(next);
    setControls(madeControls(to.looks));
  }, [showcases]);
  // another part of the page (a video on the shelf) asks for one of the videos to be played here
  useEffect(() => {
    const show = (e: Event) => {
      choose(String((e as CustomEvent).detail));
      setLive(true);
    };
    window.addEventListener(SHOW_EVENT, show);
    return () => window.removeEventListener(SHOW_EVENT, show);
  }, [choose]);
  const set = <K extends keyof Controls>(key: K, value: Controls[K]) => setControls((c) => ({ ...c, [key]: value }));
  const props = useMemo(() => restyle(showcase.props, showcase.looks, controls), [showcase, controls]);
  const resolve = useCallback((path: string) => mediaUrl(showcase.slug, showcase.looks.shared, path), [showcase]);
  const { looks, receipt } = showcase;
  const others = showcases.filter((x) => x.slug !== showcase.slug);
  const changed = JSON.stringify(controls) !== JSON.stringify(madeControls(looks));

  return (
    <section className="pb-6 pt-8 lg:pt-10" data-testid="live-stage">
      {/*
        The wall: the page's words beside the videos as a feed shows them, one in front and playing, the others
        waiting at its sides. A click on one at the side brings it to the front.
      */}
      {/* The page opens the way its parts go on: centred, the words first, then what they are about. (The title is
          in an element of its own: handed over from the server and set straight among this section's other
          children, React takes it for one of a list.) */}
      <div className="mx-auto max-w-[62rem] text-center">
        <div>{title}</div>
        {children}
      </div>
      <div className="mt-10">
        <div className="flex items-center justify-center gap-4 sm:gap-6">
          {others[0] && <Side showcase={others[0]} onPick={choose} />}
          <div id="stage" className="w-full max-w-[19.5rem] shrink-0 scroll-mt-24">
            <Stage caption={[`${receipt.seconds.toFixed(1)} s, ${receipt.scenes} scenes`, inCredits(receipt.totalUsd)]}>
              <div
                ref={frame}
                className="absolute inset-0"
                data-testid="showcase-player"
                data-live={live}
                data-slug={showcase.slug}
                data-caption-font={props.captions.style.font.family}
                data-cuts={props.boundaries.map((b) => b.transition).join(",")}
                data-hook={props.hook?.text ?? ""}
                data-music={props.audio.bgm !== null}
                data-brand={props.brand !== null}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/showcase/${showcase.slug}/poster.jpg`} alt={`A frame of “${receipt.title}”, a video made with Flow Chain AI`} fetchPriority="high" className="absolute inset-0 h-full w-full object-cover" />
                {live && (
                  <motion.div key={showcase.slug} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }} className="absolute inset-0">
                    <ShowcasePlayer props={props} resolve={resolve} autoPlay={!still} handle={player} />
                  </motion.div>
                )}
              </div>
            </Stage>
          </div>
          {others[1] && <Side showcase={others[1]} onPick={choose} />}
        </div>
      </div>

      {/* the video's scenes, in order: a touch on one plays the video from there */}
      <ol className="-mx-6 mt-12 flex gap-3 overflow-x-auto px-6 pb-2 sm:-mx-10 sm:px-10 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0" data-testid="board" aria-label={`The scenes of “${receipt.title}”, in order`}>
        {showcase.making.scenes.map((scene, i) => (
          <li key={`${showcase.slug}-${i}`} className="w-[17rem] shrink-0 lg:w-auto">
            <button
              type="button" data-testid={`board-${i + 1}`} aria-label={`Play from scene ${i + 1}`}
              onClick={(e) => player.current?.playFrom(props.scenes[i]?.from ?? 0, e)}
              className="group flex h-full w-full items-center gap-3.5 rounded-[18px] bg-sheet p-2.5 pr-4 text-left hover:bg-wash"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/showcase/${showcase.slug}/${scene.thumb}`} alt="" loading="lazy" className="aspect-[9/16] w-14 shrink-0 rounded-[10px] object-cover" />
              <span className="min-w-0">
                <span className="note block text-[0.85rem]">{i + 1}. {scene.kind === "clip" ? "Moving clip" : "Still, camera moves"}, {scene.seconds.toFixed(1)} s</span>
                <span className="mt-1 line-clamp-3 block text-[0.82rem] leading-snug text-graphite">{scene.narration}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {/* the desk under the monitor: what a free re-render can change, changed here at once */}
      <form className="ruled mt-12" aria-label="Restyle this video" onSubmit={(e) => e.preventDefault()}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
          <p className="max-w-[44rem] text-[1.02rem] leading-snug">
            The video above is not a recording. It is the real renderer, running in your browser on a video Flow Chain AI made: change how it is captioned and cut, and nothing is bought.
          </p>
          <button type="button" onClick={() => setControls(madeControls(looks))} disabled={!changed} data-testid="restyle-reset" className="text-[0.95rem] underline underline-offset-4 disabled:opacity-40">
            Back to how it was made
          </button>
        </div>
        <div className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.1fr)]">
          <fieldset>
            <legend className="text-[0.9rem] font-bold">Video</legend>
            <div className="mt-2 flex gap-2.5">
              {showcases.map((s) => (
                <label key={s.slug} title={s.receipt.title} className={`relative block w-12 shrink-0 cursor-pointer overflow-hidden rounded-[14px] outline-offset-2 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-signal ${s.slug === slug ? "ring-[3px] ring-signal ring-offset-2 ring-offset-paper" : "opacity-70 hover:opacity-100"}`}>
                  <input type="radio" name="video" value={s.slug} checked={s.slug === slug} onChange={() => choose(s.slug)} className="sr-only" aria-label={s.receipt.title} />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/showcase/${s.slug}/poster.jpg`} alt="" loading="lazy" className="aspect-[9/16] w-full object-cover" />
                </label>
              ))}
            </div>
          </fieldset>
          <Choice label="Captions" options={CAPTIONS} value={controls.captions} onChange={(v) => set("captions", v)} />
          <Choice label="Cuts" options={CUTS} value={controls.cuts} onChange={(v) => set("cuts", v)} />
          <div className="space-y-3">
            {looks.hook && (
              <div>
                <Toggle label="Opening title" checked={controls.hook} onChange={(v) => set("hook", v)} />
                <input
                  type="text" value={controls.hookText} onChange={(e) => set("hookText", e.target.value.slice(0, 60))} disabled={!controls.hook}
                  placeholder={looks.hook.text} aria-label="The opening title's words" data-testid="hook-text"
                  className="mt-2 w-full rounded-full border border-hairline bg-sheet px-3 py-2 text-[0.95rem] placeholder:text-graphite/70 disabled:opacity-40"
                />
              </div>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-2.5">
              {looks.brand && <Toggle label="Brand" checked={controls.brand} onChange={(v) => set("brand", v)} />}
              {looks.bgm && <Toggle label="Music" checked={controls.music} onChange={(v) => set("music", v)} />}
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
