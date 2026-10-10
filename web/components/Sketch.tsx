/*
 * What is drawn on the site rather than printed: frames, arrows, underlines. Each is drawn the way an animator
 * draws on a board: loosely in non-photo blue first, then over it in pencil, so a shape has two lines and
 * neither is quite straight (phase 4 spec §15). They are pictures, hidden from assistive technology, and they
 * stretch to whatever they are put around; the line keeps its weight when they do.
 *
 * The unevenness is worked out from a number, not left to chance: the same frame is the same on the server and
 * in the browser, and on every visit.
 */

/** A number between -1 and 1 that depends only on what it is given. */
function wobble(seed: number, n: number): number {
  const x = Math.sin(seed * 127.1 + n * 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** A four-sided path through the corners of a 100 × 100 box, each corner off by up to `loose`, the pencil running past the last one. */
function box(seed: number, loose: number): string {
  const w = (n: number) => (wobble(seed, n) * loose).toFixed(2);
  const at = (x: number, y: number, n: number) => `${(x + Number(w(n))).toFixed(2)} ${(y + Number(w(n + 1))).toFixed(2)}`;
  // (it starts before the first corner and ends past it, as a hand closing a box does)
  return `M${at(-1.5, 0.8, 1)} L${at(100, 0, 3)} L${at(100, 100, 5)} L${at(0, 100, 7)} L${at(0.4, -2, 9)}`;
}

// (the line keeps its weight however the picture is stretched; its dashes are then measured on the screen too,
// which is what `.drawn` in the theme counts on)
const line = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round", vectorEffect: "non-scaling-stroke" } as const;

/** A frame drawn around its parent, which must be positioned. `order`: its turn when a board is drawn in (see `.drawn`). */
export function Frame({ seed = 1, order, weight = 1.9 }: { seed?: number; order?: number; weight?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className={`pointer-events-none absolute -inset-[3px] h-[calc(100%+6px)] w-[calc(100%+6px)] overflow-visible ${order === undefined ? "" : "drawn"}`} style={order === undefined ? undefined : ({ "--i": order } as React.CSSProperties)}>
      <path d={box(seed + 40, 1.5)} stroke="var(--color-hairline)" strokeWidth={weight * 0.75} {...line} />
      <path d={box(seed, 0.75)} stroke="var(--color-ink)" strokeWidth={weight} {...line} />
    </svg>
  );
}

/** An arrow from left to right, as drawn between two panels: this, then that. */
export function Arrow({ seed = 1, order, className = "" }: { seed?: number; order?: number; className?: string }) {
  const y = (n: number) => (12 + wobble(seed, n) * 2.5).toFixed(1);
  return (
    <svg aria-hidden="true" viewBox="0 0 40 24" className={`${className} ${order === undefined ? "" : "drawn"}`} style={order === undefined ? undefined : ({ "--i": order } as React.CSSProperties)}>
      <path d={`M2 ${y(1)} C12 ${y(2)} 22 ${y(3)} 36 12`} stroke="var(--color-pencil)" strokeWidth="2" {...line} />
      <path d="M28 5.5 L36.5 12 L28.5 18.5" stroke="var(--color-pencil)" strokeWidth="2" {...line} />
    </svg>
  );
}

/** A line under something, pulled once with the red pencil. It lies along the bottom of its parent, which must be positioned. */
export function Underline({ seed = 1, order }: { seed?: number; order?: number }) {
  const y = (n: number) => (5 + wobble(seed, n) * 2.2).toFixed(1);
  return (
    <svg aria-hidden="true" viewBox="0 0 200 10" preserveAspectRatio="none" className={`pointer-events-none absolute inset-x-0 -bottom-[0.18em] h-[0.22em] w-full overflow-visible ${order === undefined ? "" : "drawn"}`} style={order === undefined ? undefined : ({ "--i": order } as React.CSSProperties)}>
      <path d={`M1 ${y(1)} C50 ${y(2)} 110 ${y(3)} 199 ${y(4)}`} stroke="var(--color-pencil)" strokeWidth="3" {...line} />
    </svg>
  );
}
