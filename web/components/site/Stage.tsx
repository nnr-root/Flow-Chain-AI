/*
 * The Stage: the dark frame a video plays in, with a printer's crop marks at its corners. Until the live player
 * is mounted in it, it shows what a projector shows before a film: the countdown leader.
 */

/** Four crop marks just outside a box's corners, as on a printer's proof. Decoration: hidden from assistive technology. */
function CropMarks() {
  const mark = "absolute h-3 w-3 border-ink/40";
  return (
    <span aria-hidden="true" className="pointer-events-none absolute -inset-3">
      <span className={`${mark} left-0 top-0 border-b border-r`} />
      <span className={`${mark} right-0 top-0 border-b border-l`} />
      <span className={`${mark} bottom-0 left-0 border-r border-t`} />
      <span className={`${mark} bottom-0 right-0 border-l border-t`} />
    </span>
  );
}

/** A film's countdown leader: the target circle and cross that precede the first frame. */
function Leader() {
  return (
    <svg viewBox="0 0 90 160" className="h-full w-full" role="img" aria-label="A film's countdown leader">
      <rect width="90" height="160" fill="var(--color-stage)" />
      <g stroke="var(--color-paper)" strokeOpacity="0.28" strokeWidth="0.35" fill="none">
        <line x1="45" y1="0" x2="45" y2="160" />
        <line x1="0" y1="80" x2="90" y2="80" />
        <circle cx="45" cy="80" r="30" />
        <circle cx="45" cy="80" r="24" />
      </g>
      {/* the sweep hand, stopped at a quarter past */}
      <path d="M45 80 L45 50 A30 30 0 0 1 75 80 Z" fill="var(--color-paper)" fillOpacity="0.06" />
      <line x1="45" y1="80" x2="75" y2="80" stroke="var(--color-signal)" strokeWidth="0.6" />
      <text x="45" y="91" textAnchor="middle" fontFamily="var(--font-display)" fontSize="30" fill="var(--color-paper)" fillOpacity="0.9" style={{ fontVariationSettings: '"opsz" 144' }}>3</text>
    </svg>
  );
}

export function Stage({ children }: { children?: React.ReactNode }) {
  return (
    <figure className="mx-auto w-full max-w-[21rem]" data-testid="stage">
      {/* the marks frame the picture, as on a proof; the caption sits outside them */}
      <div className="relative">
        <CropMarks />
        <div className="relative aspect-[9/16] overflow-hidden rounded-[3px] bg-stage shadow-[0_30px_60px_-30px_rgb(20_17_15/0.55)]">
          {children ?? <Leader />}
        </div>
      </div>
      <figcaption className="figures mt-5 flex justify-between text-[0.75rem] text-graphite">
        <span>00:00:00:00</span>
        <span>1080 × 1920, 30 fps</span>
      </figcaption>
    </figure>
  );
}
