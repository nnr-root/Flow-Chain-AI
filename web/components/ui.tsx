import type { ButtonHTMLAttributes, ReactNode } from "react";

/*
 * A run's state, in the site's own terms: the highlighter is on what is happening now, a plain outline on what
 * waits for the user, red on what went wrong, and what is finished is simply said.
 */
const STATES: Record<string, { label: string; cls: string }> = {
  creating: { label: "Creating", cls: "bg-marker text-paper" },
  draft: { label: "Draft", cls: "border border-ink/40" },
  queued: { label: "Queued", cls: "bg-wash" },
  running: { label: "Working", cls: "bg-marker text-paper" },
  needs_approval: { label: "Needs approval", cls: "border border-ink/40" },
  failed: { label: "Failed", cls: "bg-bad text-paper" },
  interrupted: { label: "Interrupted", cls: "bg-bad text-paper" },
  incomplete: { label: "Unfinished", cls: "border border-ink/40" },
  done: { label: "Done", cls: "bg-ink text-paper" },
  stored: { label: "Archived", cls: "bg-wash text-graphite" },
};

export function StateBadge({ state }: { state: string }) {
  const s = STATES[state] ?? { label: state, cls: "bg-wash text-graphite" };
  return <span data-state={state} className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[0.8rem] font-bold ${s.cls}`}>{s.label}</span>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "plain" | "danger" };

export function Button({ tone = "plain", className = "", ...rest }: ButtonProps) {
  const tones = {
    primary: "bg-signal text-paper hover:bg-ink",
    plain: "bg-wash hover:bg-[#333]",
    danger: "border-[1.5px] border-bad/50 text-bad hover:bg-bad hover:text-paper",
  };
  return <button type="button" {...rest} className={`rounded-full px-4 py-2 text-[0.95rem] font-bold disabled:cursor-not-allowed disabled:opacity-45 ${tones[tone]} ${className}`} />;
}

/** A part of a page: a heading over an ink rule, and what belongs to it. Not a box: the page is the sheet. */
export function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ruled">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="printed text-[1.2rem] leading-none">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-[0.95rem]">
      <span className="mb-1.5 block font-bold">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[0.85rem] text-graphite">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="bg-bad/8 px-4 py-2.5 text-[0.95rem] text-bad">{children}</p>;
}

/** A row of mutually exclusive choices: the highlighter is on the one chosen. */
export function Segmented<T extends string>({ value, options, onChange, disabled, label }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; disabled?: boolean; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-full border-[1.5px] border-ink/30 bg-sheet p-0.5 text-[0.85rem]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 font-bold disabled:opacity-50 ${o.value === value ? "bg-marker text-paper" : "text-graphite hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
