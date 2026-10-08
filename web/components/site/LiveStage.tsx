"use client";
import { motion, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { type Controls, madeControls, mediaUrl, restyle } from "@/lib/site/restyle";
import { SHOW_EVENT, type Showcase } from "@/lib/site/showcases";
import { Stage } from "./Stage";

// the player and the composition are the heavy part of the page: fetched after the poster is on screen
const ShowcasePlayer = dynamic(() => import("./ShowcasePlayer"), { ssr: false });

/** The one spring the controls move with (Phase 4 spec §3.4, "snap"). */
const SNAP = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;

const CAPTIONS: Array<[Controls["captions"], string]> = [["preset", "Matched"], ["hormozi", "Punchy"], ["mrbeast", "Playful"], ["minimalist", "Quiet"]];
const CUTS: Array<[Controls["cuts"], string]> = [["auto", "As scripted"], ["cut", "Hard cut"], ["fade", "Fade"], ["dissolve", "Dissolve"], ["blur", "Blur"], ["zoom", "Zoom"], ["glitch", "Glitch"]];
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** A row of choices where one is on; the mark under it slides to the one chosen. */
function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: Array<[T, string]>; value: T; onChange: (v: T) => void }) {
  const group = useId();
  return (
    <fieldset>
      <legend className="text-[0.8rem] text-graphite">{label}</legend>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {options.map(([id, name]) => (
          <label key={id} className="relative cursor-pointer pb-1.5 text-[0.95rem] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal">
            <input type="radio" name={group} value={id} checked={value === id} onChange={() => onChange(id)} className="sr-only" />
            <span className={value === id ? "text-ink" : "text-graphite hover:text-ink"}>{name}</span>
            {value === id && <motion.span layoutId={`${group}-mark`} transition={SNAP} className="absolute inset-x-0 bottom-0 h-[2px] bg-signal" />}
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
      <span aria-hidden="true" className="relative h-[1.15rem] w-8 shrink-0 rounded-full bg-ink/15 transition-colors peer-checked:bg-ink peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal">
        <motion.span animate={{ x: checked ? 14 : 0 }} transition={SNAP} className="absolute left-[3px] top-[3px] h-3 w-3 rounded-full bg-paper" />
      </span>
      {label}
    </label>
  );
}

/**
 * The hero: the page's words (`children`) beside the Stage with a real video in the real renderer, and under
 * both the controls that restyle it (Phase 4 spec §6). The poster is on screen first; the player takes its place
 * once it is fetched and the Stage is in view.
 */
export function LiveStage({ showcases, children }: { showcases: Showcase[]; children: React.ReactNode }) {
  const [slug, setSlug] = useState(showcases[0].slug);
  const showcase = showcases.find((s) => s.slug === slug) ?? showcases[0];
  const [controls, setControls] = useState<Controls>(() => madeControls(showcase.looks));
  const [live, setLive] = useState(false);
  const still = useReducedMotion() ?? false;
  const frame = useRef<HTMLDivElement>(null);

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
  const changed = JSON.stringify(controls) !== JSON.stringify(madeControls(looks));

  return (
    <section className="pb-10 pt-14 lg:pt-20" data-testid="live-stage">
      <div className="grid items-center gap-x-10 gap-y-12 lg:grid-cols-12">
        <div className="lg:col-span-7">{children}</div>
        <div id="stage" className="w-full max-w-[21rem] scroll-mt-24 justify-self-center lg:col-span-5 lg:justify-self-end">
          <Stage caption={[`${receipt.seconds.toFixed(1)} s, ${receipt.scenes} scenes`, `${usd(receipt.totalUsd)} of credit`]}>
            <div
              ref={frame}
              className="absolute inset-0"
              data-testid="showcase-player"
              data-live={live}
              data-slug={showcase.slug}
              data-caption-font={props.captions.style.font.family}
              data-cuts={props.boundaries.map((b) => b.transition).join(",")}
              data-hook={props.hook?.text ?? ""}
              data-sounds={props.audio.sfx.length}
              data-music={props.audio.bgm !== null}
              data-brand={props.brand !== null}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/showcase/${showcase.slug}/poster.jpg`} alt={`A frame of “${receipt.title}”, a video made with Flow Chain`} fetchPriority="high" className="absolute inset-0 h-full w-full object-cover" />
              {live && (
                <motion.div key={showcase.slug} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }} className="absolute inset-0">
                  <ShowcasePlayer props={props} resolve={resolve} autoPlay={!still} />
                </motion.div>
              )}
        </div>
          </Stage>
        </div>
      </div>

      {/* the desk under the monitor: what a free re-render can change, changed here at once */}
      <form className="glass mt-12 rounded-[10px] border border-hairline p-5 sm:p-6" aria-label="Restyle this video" onSubmit={(e) => e.preventDefault()}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
          <p className="max-w-[46rem] text-[0.95rem] leading-snug">
            This is the real renderer, running in your browser on a video Flow Chain made. Change how it is cut and captioned; nothing is bought.
          </p>
          <button type="button" onClick={() => setControls(madeControls(looks))} disabled={!changed} data-testid="restyle-reset" className="text-[0.9rem] underline decoration-hairline decoration-2 underline-offset-4 hover:decoration-ink disabled:opacity-40 disabled:hover:decoration-hairline">
            Back to how it was made
          </button>
        </div>
        <div className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.1fr)]">
          <fieldset>
            <legend className="text-[0.8rem] text-graphite">Video</legend>
            <div className="mt-2 flex gap-2.5">
              {showcases.map((s) => (
                <label key={s.slug} title={s.receipt.title} className={`relative block w-12 shrink-0 cursor-pointer overflow-hidden rounded-[3px] outline-offset-2 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-signal ${s.slug === slug ? "ring-2 ring-ink ring-offset-2 ring-offset-paper" : "opacity-70 hover:opacity-100"}`}>
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
                  className="mt-2 w-full rounded-md border border-hairline bg-paper/70 px-3 py-2 text-[0.95rem] placeholder:text-graphite/70 disabled:opacity-40"
                />
              </div>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-2.5">
              {looks.brand && <Toggle label="Brand" checked={controls.brand} onChange={(v) => set("brand", v)} />}
              {looks.bgm && <Toggle label="Music" checked={controls.music} onChange={(v) => set("music", v)} />}
              <Toggle label="Sound effects" checked={controls.sfx} onChange={(v) => set("sfx", v)} />
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
