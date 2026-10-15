"use client";

export type LayerOption = { id: string; label: string; about: string; disabled?: string };

/**
 * One of the layers a video is built from (phase 8 spec §1): a video type, an edit. A row of names to choose one
 * from, or none (`noneLabel`), and a line saying what the chosen one is. An option that cannot go with the rest of
 * the form says why (`disabled`) and cannot be chosen.
 */
export function LayerPicker({ name, options, value, onChange, noneLabel, noneAbout }: { name: string; options: LayerOption[]; value: string | undefined; onChange: (id: string | undefined) => void; noneLabel: string; noneAbout: string }) {
  const chosen = options.find((o) => o.id === value);
  const chip = (on: boolean, off = false) =>
    `shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[0.88rem] font-bold ${on ? "bg-signal text-paper" : off ? "bg-sheet text-graphite/50 cursor-not-allowed" : "bg-sheet text-ink hover:bg-wash"}`;
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="space-y-3">
      {/* (one row to scroll on a phone; wrapped where there is room) */}
      <div role="radiogroup" aria-label={name} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
        <button type="button" role="radio" aria-checked={value === undefined} data-testid={`${slug}-none`} onClick={() => onChange(undefined)} className={chip(value === undefined)}>{noneLabel}</button>
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={value === o.id} aria-disabled={o.disabled ? true : undefined} title={o.disabled} data-testid={`${slug}-${o.id}`}
            onClick={() => !o.disabled && onChange(o.id)} className={chip(value === o.id, Boolean(o.disabled))}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-[0.88rem] text-graphite" data-testid={`${slug}-about`}>{chosen ? `${chosen.about}.` : noneAbout}</p>
    </div>
  );
}
