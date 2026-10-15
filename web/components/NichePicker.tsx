"use client";
import { NICHE_TEXT_MAX, NICHES, nicheById } from "@src/niches";

export type NicheChoice = { kind: "none" } | { kind: "known"; id: string } | { kind: "custom"; text: string };

/**
 * The kind of video it is (phase 7 spec §19): one of the studio's niches, one in the user's own words, or none.
 * A niche writes the script the way videos in it hold their audience; it is never required. A niche's example
 * topics can be taken as the video's topic with a press (`onExample`), where there is a topic to fill.
 */
export function NichePicker({ value, onChange, onExample }: { value: NicheChoice; onChange: (v: NicheChoice) => void; onExample?: (topic: string) => void }) {
  const known = value.kind === "known" ? nicheById(value.id) : undefined;
  const chip = (on: boolean) => `shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[0.88rem] font-bold ${on ? "bg-signal text-paper" : "bg-sheet text-ink hover:bg-wash"}`;
  return (
    <div className="space-y-3">
      {/* (one row to scroll on a phone, where sixteen names would stand eight rows tall; wrapped where there is room) */}
      <div role="radiogroup" aria-label="Niche" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
        <button type="button" role="radio" aria-checked={value.kind === "none"} data-testid="niche-none" onClick={() => onChange({ kind: "none" })} className={chip(value.kind === "none")}>Any</button>
        {NICHES.map((n) => (
          <button key={n.id} type="button" role="radio" aria-checked={value.kind === "known" && value.id === n.id} data-testid={`niche-${n.id}`} onClick={() => onChange({ kind: "known", id: n.id })} className={chip(value.kind === "known" && value.id === n.id)}>
            {n.label}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={value.kind === "custom"} data-testid="niche-custom" onClick={() => onChange({ kind: "custom", text: value.kind === "custom" ? value.text : "" })} className={chip(value.kind === "custom")}>
          My own…
        </button>
      </div>
      {known && (
        <div className="space-y-2 text-[0.88rem]" data-testid="niche-about">
          <p className="text-graphite">{known.about}.{known.kind === "fiction" ? " Made-up stories, told as such." : " True things only: the script is told to say nothing it cannot stand behind."}</p>
          {onExample && (
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-graphite">Try:</span>
              {known.examples.map((e) => (
                <button key={e} type="button" data-testid="niche-example" onClick={() => onExample(e)} className="rounded-full border border-hairline px-2.5 py-1 text-[0.82rem] hover:border-ink">{e}</button>
              ))}
            </p>
          )}
        </div>
      )}
      {value.kind === "custom" && (
        <label className="block">
          <span className="sr-only">Your niche</span>
          <input
            data-testid="niche-text"
            maxLength={NICHE_TEXT_MAX}
            value={value.text}
            onChange={(e) => onChange({ kind: "custom", text: e.target.value.replace(/[\r\n]/g, " ") })}
            placeholder="Your channel in a line: cozy facts about cats, for cat owners"
          />
          <span className="mt-1.5 block text-[0.82rem] text-graphite">Who the videos are for and what kind they are. The script keeps to the studio&apos;s rules whatever it says.</span>
        </label>
      )}
    </div>
  );
}
