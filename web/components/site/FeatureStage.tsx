"use client";
import { useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inWords } from "@/lib/site/calculator";
import { type Controls, madeControls, mediaUrl, restyle } from "@/lib/site/restyle";
import type { Showcase } from "@/lib/site/showcases";
import type { ShowcasePlayerHandle } from "./ShowcasePlayer";
import { Stage } from "./Stage";

const ShowcasePlayer = dynamic(() => import("./ShowcasePlayer"), { ssr: false });

const SOUND: Record<string, string> = { "sfx/impact_boom.mp3": "an impact", "sfx/whoosh.mp3": "a whoosh", "sfx/pop.mp3": "a pop" };
const at = (frame: number, fps: number): string => `${Math.floor(frame / fps / 60)}:${(frame / fps % 60).toFixed(1).padStart(4, "0")}`;

function Feature({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <li className="border-t border-hairline py-7 first:border-t-0 first:pt-0">
      <h3 className="display text-[1.9rem] leading-[1.05]">{name}</h3>
      <div className="mt-3 max-w-[34rem] space-y-4 text-[1.02rem] leading-[1.5]">{children}</div>
    </li>
  );
}

const act = "rounded-md border border-ink/25 px-3.5 py-2 text-[0.95rem] hover:border-ink";

/**
 * The features, each shown on a real video rather than described (Phase 4 spec §5, block 4): a video made with a
 * brand kit, and beside it the things that would otherwise be an editor's work, each with the one control that
 * shows it. The player is the real renderer, as in the hero; it is fetched when this part of the page is reached.
 */
export function FeatureStage({ showcase }: { showcase: Showcase }) {
  const { looks, receipt } = showcase;
  const [controls, setControls] = useState<Controls>(() => madeControls(looks));
  const [live, setLive] = useState(false);
  const still = useReducedMotion() ?? false;
  const frame = useRef<HTMLDivElement>(null);
  const player = useRef<ShowcasePlayerHandle>(null);

  useEffect(() => {
    const node = frame.current;
    if (!node || live) return;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setLive(true);
        seen.disconnect();
      }
    }, { rootMargin: "200px" });
    seen.observe(node);
    return () => seen.disconnect();
  }, [live]);

  const set = <K extends keyof Controls>(key: K, value: Controls[K]) => setControls((c) => ({ ...c, [key]: value }));
  const props = useMemo(() => restyle(showcase.props, looks, controls), [showcase, looks, controls]);
  const resolve = useCallback((path: string) => mediaUrl(showcase.slug, looks.shared, path), [showcase, looks]);
  const cues = looks.cuts[controls.cuts].sfx[controls.hook && looks.hook ? "hook" : "plain"];

  return (
    <div className="grid gap-x-16 gap-y-12 lg:grid-cols-12" data-testid="features">
      <div className="lg:col-span-4">
        <div className="mx-auto w-full max-w-[19rem] lg:sticky lg:top-10">
          <Stage caption={[`${receipt.seconds.toFixed(1)} s, ${receipt.scenes} scenes`, `$${receipt.totalUsd.toFixed(2)} of credit`]}>
            <div ref={frame} className="absolute inset-0" data-testid="feature-player" data-live={live} data-brand={props.brand !== null} data-hook={props.hook?.text ?? ""} data-sounds={props.audio.sfx.length}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/showcase/${showcase.slug}/poster.jpg`} alt={`A frame of “${receipt.title}”`} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
              {live && (
                <div className="absolute inset-0">
                  <ShowcasePlayer props={props} resolve={resolve} autoPlay={!still} handle={player} />
                </div>
              )}
            </div>
          </Stage>
        </div>
      </div>
      <ul className="lg:col-span-8">
        {looks.brand && (
          <Feature name="Your brand on every video">
            <p>A brand kit is a logo, and if you like a font and two colours, saved once. Every video you make with it carries the logo in a corner and your colour on the word being spoken.</p>
            <button type="button" className={act} data-testid="feature-brand" onClick={() => set("brand", !controls.brand)}>
              {controls.brand ? "Take the brand off" : "Put the brand back"}
            </button>
          </Feature>
        )}
        {looks.hook && (
          <Feature name="An opening that stops the scroll">
            <p>The first {inWords(Math.round(looks.hook.endFrame / props.fps))} seconds open with a title the script writes, a quick zoom and an impact. Reword it or leave it out; neither costs anything.</p>
            <div className="flex flex-wrap gap-3">
              <input
                type="text" value={controls.hookText} onChange={(e) => setControls((c) => ({ ...c, hook: true, hookText: e.target.value.slice(0, 60) }))}
                placeholder={looks.hook.text} aria-label="The opening title's words" data-testid="feature-hook"
                className="min-w-0 flex-1 rounded-md border border-hairline bg-paper px-3 py-2 text-[0.95rem] placeholder:text-graphite/70"
              />
              <button type="button" className={act} onClick={() => player.current?.playFrom(0)}>Play the opening</button>
            </div>
          </Feature>
        )}
        <Feature name="Sound on the cuts">
          <p>A cut gets a sound that fits it: a whoosh into a zoom or a blur, a pop on a hard cut or a glitch, nothing on a fade. Music, where there is any, is turned down under the voice.</p>
          {controls.sfx && cues.length > 0 && (
            <p className="figures text-[0.8rem] text-graphite" data-testid="feature-cues">
              In this video: {cues.map((c) => `${SOUND[c.src] ?? "a sound"} at ${at(c.frame, props.fps)}`).join(", ")}.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button type="button" className={act} onClick={() => player.current?.playFrom(0, true)}>Play it with sound</button>
            <button type="button" className={act} data-testid="feature-sfx" onClick={() => set("sfx", !controls.sfx)}>
              {controls.sfx ? "Take the sounds out" : "Put the sounds back"}
            </button>
          </div>
        </Feature>
        <Feature name="A queue that never buys twice">
          <p>Videos wait their turn and you see your place in line. Before anything is generated you are shown what it can cost at most, and that amount is the limit. If a job stops half-way it waits for you: nothing is retried, and nothing already made is bought again.</p>
        </Feature>
      </ul>
    </div>
  );
}
