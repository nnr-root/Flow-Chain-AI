import type { Prices } from "../config.js";
import { round4, scriptCost } from "../cost.js";
import { timedScriptCost } from "../duration.js";
import type { EvalCase } from "./cases.js";

/** What one judge call is expected to take: the scenes and the rubric in, scores and a note out. */
export const JUDGE_TOKENS = { input: 1800, output: 150 } as const;

export const judgeCostUsd = (p: Pick<Prices, "llmPerMInputTokens" | "llmPerMOutputTokens">): number =>
  round4((JUDGE_TOKENS.input * p.llmPerMInputTokens + JUDGE_TOKENS.output * p.llmPerMOutputTokens) / 1e6);

/** What asking for one case's answers is expected to cost, by the same arithmetic the studio charges a script. */
export function caseCostUsd(p: Prices, c: EvalCase): number {
  const r = c.request;
  if (r.ask?.kind === "translate" || !r.timing) return scriptCost(p);
  return timedScriptCost(p, r.timing);
}

export function estimateUsd(p: Prices, cases: readonly EvalCase[], repeats: number, judge: boolean): number {
  const each = cases.reduce((sum, c) => sum + caseCostUsd(p, c) + (judge ? judgeCostUsd(p) : 0), 0);
  return round4(each * repeats);
}

export type EvalArgs = { cap: number; repeats: number; cases: string[] | null; judge: boolean; saveBaseline: boolean };

export function parseArgs(argv: readonly string[]): EvalArgs | { error: string } {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const capRaw = value("--cap");
  if (capRaw === undefined) return { error: "--cap <usd> is required: this spends money" };
  const cap = Number(capRaw);
  if (!Number.isFinite(cap) || cap <= 0) return { error: "--cap must be a positive number of dollars" };
  const repeats = value("--repeats") === undefined ? 3 : Number(value("--repeats"));
  if (!Number.isInteger(repeats) || repeats < 1) return { error: "--repeats must be a whole number, 1 or more" };
  const saveBaseline = argv.includes("--save-baseline");
  if (saveBaseline && repeats < 3) return { error: "a baseline needs --repeats 3 or more, so its spread means something" };
  return { cap, repeats, cases: value("--cases")?.split(",").filter(Boolean) ?? null, judge: !argv.includes("--no-judge"), saveBaseline };
}
