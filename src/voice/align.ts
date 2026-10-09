import type { WordTiming } from "../manifest/schema.js";

/*
 * When each word of a script line is spoken (phase 5 spec §6.1). The voice engine gives no times; a speech
 * recogniser listens to what it said and gives the times of the words it HEARD. Those are not the script's
 * words: it writes "2026" where the script says so and the voice said four words, it may mishear a name, and it
 * splits and joins words its own way. Captions show the script, so the script's words are laid over the heard
 * ones: a word that was heard takes its own time, and words in between share the time between their neighbours.
 */

/** A word as it is compared: lower case, no accents or punctuation, Turkish dotless i as i. */
export function fold(word: string): string {
  return word
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .normalize("NFKD").replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The script's own words with their times. `heard`: the recogniser's words in order; `seconds`: the clip's
 * length. Every word gets a time, they never overlap or run backwards, and all lie inside the clip.
 */
export function alignWords(text: string, heard: WordTiming[], seconds: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const length = Math.max(seconds, 0.001);
  const h = heard.filter((w) => fold(w.text) !== "" && Number.isFinite(w.start) && Number.isFinite(w.end));
  const a = words.map(fold);
  const b = h.map((w) => fold(w.text));

  // Fewest edits that turn what was heard into the script (a word kept, swapped, left out or put in).
  const n = a.length;
  const m = b.length;
  const cost = Array.from({ length: n + 1 }, (_, i) => new Uint32Array(m + 1).fill(0).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[i][j] = Math.min(cost[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }
  // Walking back: which heard word, if any, stands where each script word is. Only a word heard AS WRITTEN is
  // an anchor; a swapped one ("2026" against "twenty") marks the place but its time is its neighbours' to share.
  const anchor: Array<number | undefined> = new Array<number | undefined>(n).fill(undefined);
  for (let i = n, j = m; i > 0 && j > 0; ) {
    if (a[i - 1] === b[j - 1] && cost[i][j] === cost[i - 1][j - 1]) {
      anchor[i - 1] = j - 1;
      i--;
      j--;
    } else if (cost[i][j] === cost[i - 1][j - 1] + 1) {
      i--;
      j--;
    } else if (cost[i][j] === cost[i - 1][j] + 1) i--;
    else j--;
  }

  const out: WordTiming[] = new Array<WordTiming>(n);
  const clamp = (t: number) => Math.min(Math.max(t, 0), length);
  let i = 0;
  let from = 0; // where the last placed word ended
  while (i < n) {
    if (anchor[i] !== undefined) {
      const w = h[anchor[i]!];
      const start = Math.max(clamp(w.start), from);
      const end = Math.max(clamp(w.end), start);
      out[i] = { text: words[i], start, end };
      from = end;
      i++;
      continue;
    }
    // a run of words that were not heard as written: they share the time up to the next anchor (or the end)
    let k = i;
    while (k < n && anchor[k] === undefined) k++;
    const until = k < n ? Math.max(clamp(h[anchor[k]!].start), from) : Math.max(clamp(h.at(-1)?.end ?? length), from, k === n && h.length === 0 ? length : 0);
    const weights = words.slice(i, k).map((w) => Math.max(w.length, 1));
    const total = weights.reduce((sum, x) => sum + x, 0);
    let t = from;
    for (let x = i; x < k; x++) {
      const share = ((until - from) * weights[x - i]) / total;
      out[x] = { text: words[x], start: t, end: t + share };
      t += share;
    }
    from = until;
    i = k;
  }
  return out.map((w) => ({ text: w.text, start: round3(w.start), end: round3(Math.max(w.end, w.start)) }));
}

/** How much of the script was heard as written, 0 to 1: what tells a clip that was spoken from one that went wrong. */
export function heardShare(text: string, heard: WordTiming[]): number {
  const script = text.split(/\s+/).map(fold).filter(Boolean);
  if (script.length === 0) return 1;
  const pool = new Map<string, number>();
  for (const w of heard) pool.set(fold(w.text), (pool.get(fold(w.text)) ?? 0) + 1);
  let found = 0;
  for (const w of script) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      found++;
      pool.set(w, left - 1);
    }
  }
  return found / script.length;
}
