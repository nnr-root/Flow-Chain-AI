"use client";
import { useRef } from "react";

export type StyleCard = { name: string; label: string; description: string; image: string | null };

/**
 * The styles, side by side, each as a picture made in it (phase 7 spec §13): a style is something to look at,
 * and a sentence about one tells less than the picture does. The one that is chosen is described underneath.
 * A style without a picture yet is shown by its name alone.
 */
export function StylePicker({ styles, value, onChange }: { styles: StyleCard[]; value: string; onChange: (name: string) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const cards: StyleCard[] = [{ name: "auto", label: "Choose for me", description: "", image: null }, ...styles];
  const chosen = cards.find((c) => c.name === value) ?? cards[0];
  // (four of the styles' own pictures stand for "any of them")
  const sample = styles.filter((s) => s.image).slice(0, 4);
  const move = (by: number) => row.current?.scrollBy({ left: by * row.current.clientWidth * 0.8, behavior: "smooth" });
  return (
    <div>
      <div className="relative">
        <div ref={row} role="radiogroup" aria-label="Style" className="-mx-1 flex snap-x items-start gap-3 overflow-x-auto px-1 pb-3 pt-1 [scrollbar-width:thin]">
          {cards.map((c) => {
            const on = c.name === value;
            return (
              <button key={c.name} type="button" role="radio" aria-checked={on} data-testid={`look-${c.name}`} onClick={() => onChange(c.name)} className="group w-[8.25rem] shrink-0 snap-start text-left">
                <span className={`relative block aspect-[9/16] overflow-hidden rounded-[18px] bg-sheet outline-offset-2 ${on ? "outline outline-[3px] outline-signal" : "outline-0 group-hover:outline group-hover:outline-2 group-hover:outline-ink/40"}`}>
                  {c.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.image} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : c.name === "auto" && sample.length === 4 ? (
                    <span className="grid h-full w-full grid-cols-2 grid-rows-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {sample.map((s) => <img key={s.name} src={s.image!} alt="" loading="lazy" className="h-full w-full object-cover" />)}
                    </span>
                  ) : (
                    <span className="flex h-full w-full items-end p-3 text-[0.85rem] text-graphite">{c.name === "auto" ? "Any of them" : "No picture yet"}</span>
                  )}
                </span>
                <span className="mt-2 block text-[0.9rem] font-bold leading-tight"><span className={on ? "marked" : ""}>{c.label}</span></span>
              </button>
            );
          })}
        </div>
        <div className="mt-1 hidden gap-2 sm:flex">
          <button type="button" aria-label="Earlier styles" onClick={() => move(-1)} className="grid h-9 w-9 place-items-center rounded-full bg-sheet text-[1.1rem] font-bold hover:bg-wash">‹</button>
          <button type="button" aria-label="More styles" onClick={() => move(1)} className="grid h-9 w-9 place-items-center rounded-full bg-sheet text-[1.1rem] font-bold hover:bg-wash">›</button>
        </div>
      </div>
      <p className="mt-4 max-w-[40rem] text-[0.95rem]" data-testid="style-note" aria-live="polite">
        <span className="font-bold">{chosen.label}.</span>{" "}
        <span className="text-graphite">
          {chosen.name === "auto"
            ? "The style that fits your topic is picked when the script is written. You see which before anything is generated."
            : `Suits ${chosen.description}. It sets the pictures, how they move, and the look of the captions.`}
        </span>
      </p>
    </div>
  );
}
