"use client";
import { SHOW_EVENT, type Showcase } from "@/lib/site/showcases";
import { Receipt } from "./Receipt";

const cents = (usd: number): string => `${Math.round(usd * 100)} cents`;

/**
 * The videos the product made, each with its receipt (Phase 4 spec §5, block 5): what stands in for
 * testimonials until there are real ones. The sentence under them is worked out from the receipts themselves.
 */
export function Shelf({ showcases }: { showcases: Showcase[] }) {
  const own = showcases.filter((s) => /our own GPU/.test(s.receipt.engines.clips));
  const hosted = showcases.filter((s) => !own.includes(s));
  const moving = (s: Showcase) => s.making.scenes.filter((scene) => scene.kind === "clip").length;
  /** "32 cents, with 3 moving scenes": the two things that make one video's cost comparable with another's. */
  const cost = (s: Showcase) => `${cents(s.receipt.totalUsd)}, with ${moving(s)} moving ${moving(s) === 1 ? "scene" : "scenes"}`;
  const play = (slug: string) => {
    window.dispatchEvent(new CustomEvent(SHOW_EVENT, { detail: slug }));
    document.getElementById("stage")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <div data-testid="shelf">
      <ul className="grid gap-x-10 gap-y-14 md:grid-cols-3">
        {showcases.map((s) => (
          <li key={s.slug} className="flex items-start gap-4">
            <button type="button" onClick={() => play(s.slug)} data-testid={`shelf-play-${s.slug}`} className="group relative w-24 shrink-0 overflow-hidden rounded-[3px]" aria-label={`Play “${s.receipt.title}” in the player above`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/showcase/${s.slug}/poster.jpg`} alt="" loading="lazy" className="aspect-[9/16] w-full object-cover" />
              <span className="glass absolute inset-x-1.5 bottom-1.5 rounded-[4px] py-1 text-center text-[0.75rem] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">Play above</span>
            </button>
            <Receipt receipt={s.receipt} />
          </li>
        ))}
      </ul>
      {own.length > 0 && hosted.length > 0 && (
        <p className="mt-12 max-w-[44rem] text-[1.1rem] leading-[1.5]" data-testid="shelf-compare">
          Made on our own GPU: {own.map(cost).join("; ")}. Made with hosted models: {hosted.map(cost).join("; ")}.
          The script writer, the voice and the cut are the same in all three; what differs is which models make the pictures, and where they run.
        </p>
      )}
      <p className="mt-4 max-w-[44rem] text-[0.92rem] text-graphite">
        These are amounts of credit, at exactly what the models charged for these three videos. Other videos cost more or less with their length and how many scenes move.
      </p>
    </div>
  );
}
