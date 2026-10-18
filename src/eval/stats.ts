import type { CaseOutcome } from "./run.js";

export type Spread = { mean: number; spread: number; n: number };
export type Metrics = Record<string, Spread>;
export type RunRecord = { caseId: string; repeat: number; outcome: CaseOutcome; judge?: Record<string, number | null> };
export type Baseline = { promptVersion: string; judgeModel: string; repeats: number; metrics: Metrics };
export type Comparison = { regressed: Array<{ metric: string; before: number; after: number }>; improved: Array<{ metric: string; before: number; after: number }> };

/** The smallest drop in a score that is a change at all (phase 9 spec §6): under it, a zero spread would flag noise. */
export const MIN_DROP = 0.05;

export function spreadOf(xs: readonly number[]): Spread {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const spread = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, spread, n };
}

const accepted = (r: RunRecord): number => (r.outcome.steps.every((s) => s.accepted) ? 1 : 0);
const clean = (r: RunRecord): number => (r.outcome.steps.every((s) => s.extra.length === 0) ? 1 : 0);
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Every score the eval reports, each as a mean and a spread over the repeats: the share of cases whose answers
 * were all accepted the first time (the money measure), the share with no extra finding, and each judge score.
 * A score that is a mean over the cases is computed once per repeat, so its spread is the repeats' own.
 */
export function metricsOf(runs: readonly RunRecord[]): Metrics {
  const repeats = [...new Set(runs.map((r) => r.repeat))];
  const perRepeat = (value: (rs: RunRecord[]) => number | null): Spread | undefined => {
    const xs = repeats.map((k) => value(runs.filter((r) => r.repeat === k))).filter((x): x is number => x !== null);
    return xs.length ? spreadOf(xs) : undefined;
  };
  const out: Metrics = {};
  const put = (key: string, s: Spread | undefined): void => {
    if (s) out[key] = s;
  };
  put("accepted", perRepeat((rs) => (rs.length ? mean(rs.map(accepted)) : null)));
  put("extra", perRepeat((rs) => (rs.length ? mean(rs.map(clean)) : null)));
  for (const id of new Set(runs.map((r) => r.caseId))) {
    put(`accepted:${id}`, spreadOf(runs.filter((r) => r.caseId === id).map(accepted)));
  }
  const criteria = new Set(runs.flatMap((r) => Object.keys(r.judge ?? {})));
  for (const c of criteria) {
    put(`judge:${c}`, perRepeat((rs) => {
      const scores = rs.map((r) => r.judge?.[c]).filter((x): x is number => typeof x === "number");
      return scores.length ? mean(scores) : null;
    }));
  }
  return out;
}

/** A drop is a regression only when it is bigger than both runs' own spread and than `minDrop`; a gain the same way. */
export function compare(now: Metrics, base: Metrics, minDrop = MIN_DROP): Comparison {
  const regressed: Comparison["regressed"] = [];
  const improved: Comparison["improved"] = [];
  for (const [metric, a] of Object.entries(now)) {
    const b = base[metric];
    if (!b) continue;
    const bar = Math.max(b.spread, a.spread, minDrop);
    if (b.mean - a.mean > bar) regressed.push({ metric, before: b.mean, after: a.mean });
    else if (a.mean - b.mean > bar) improved.push({ metric, before: b.mean, after: a.mean });
  }
  return { regressed, improved };
}

const fixed = (x: number): string => x.toFixed(2);

export function summaryText(version: string, metrics: Metrics, cmp: Comparison | null): string {
  const lines = [`# Prompt eval, ${version}`, "", "| metric | mean | spread | runs |", "|---|---|---|---|"];
  for (const [k, s] of Object.entries(metrics)) lines.push(`| ${k} | ${fixed(s.mean)} | ${fixed(s.spread)} | ${s.n} |`);
  if (cmp) {
    const row = (r: { metric: string; before: number; after: number }): string => `- ${r.metric}: ${fixed(r.before)} → ${fixed(r.after)}`;
    lines.push("", `## Regressions against the baseline (${cmp.regressed.length})`, ...cmp.regressed.map(row), "", `## Improvements (${cmp.improved.length})`, ...cmp.improved.map(row));
  }
  return `${lines.join("\n")}\n`;
}
