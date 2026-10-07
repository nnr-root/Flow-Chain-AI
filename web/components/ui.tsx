import type { ButtonHTMLAttributes, ReactNode } from "react";

const STATES: Record<string, { label: string; cls: string }> = {
  creating: { label: "Creating", cls: "bg-accent/15 text-accent" },
  draft: { label: "Draft", cls: "bg-warn/15 text-warn" },
  queued: { label: "Queued", cls: "bg-accent/15 text-accent" },
  running: { label: "Working", cls: "bg-accent/15 text-accent" },
  needs_approval: { label: "Needs approval", cls: "bg-warn/15 text-warn" },
  failed: { label: "Failed", cls: "bg-bad/15 text-bad" },
  interrupted: { label: "Interrupted", cls: "bg-bad/15 text-bad" },
  incomplete: { label: "Unfinished", cls: "bg-warn/15 text-warn" },
  done: { label: "Done", cls: "bg-good/15 text-good" },
};

export function StateBadge({ state }: { state: string }) {
  const s = STATES[state] ?? { label: state, cls: "bg-line text-dim" };
  return <span data-state={state} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "plain" | "danger" };

export function Button({ tone = "plain", className = "", ...rest }: ButtonProps) {
  const tones = {
    primary: "bg-accent text-ink hover:brightness-110",
    plain: "border border-line bg-panel hover:border-dim",
    danger: "border border-bad/50 text-bad hover:bg-bad/10",
  };
  return <button type="button" {...rest} className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${className}`} />;
}

export function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-dim uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-dim">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p role="alert" className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{children}</p>;
}

/** A row of mutually exclusive choices. */
export function Segmented<T extends string>({ value, options, onChange, disabled, label }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; disabled?: boolean; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-lg border border-line text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 disabled:opacity-50 ${o.value === value ? "bg-accent text-ink" : "bg-panel text-dim hover:text-white"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
