import type { Prices } from "../config.js";
import type { LlmProvider } from "../providers/types.js";
import type { EvalCase } from "./cases.js";
import { caseCostUsd, judgeCostUsd } from "./cost.js";
import { judgePrompt, judgeScores } from "./judge.js";
import { runCase } from "./run.js";
import { metricsOf, type Metrics, type RunRecord } from "./stats.js";

export type EvalInput = {
  llm: Pick<LlmProvider, "generateScript">;
  /** Answers the judge's question; null = no judge pass. */
  judge: ((prompt: string) => Promise<unknown>) | null;
  cases: readonly EvalCase[];
  repeats: number;
  capUsd: number;
  prices: Prices;
};
export type EvalOutput = { runs: RunRecord[]; metrics: Metrics; spentUsd: number; stoppedByCap: boolean; /** Why the run ended early on an error from the model (short, never the error itself). */ aborted?: string };

/**
 * Runs every case `repeats` times, the repeats outermost so a run cut short by the cap still has whole repeats
 * of every case. Before each call it adds that call's expected cost and stops when the cap would be passed.
 */
export async function runEval(input: EvalInput): Promise<EvalOutput> {
  const runs: RunRecord[] = [];
  let spent = 0;
  for (let repeat = 0; repeat < input.repeats; repeat++) {
    for (const c of input.cases) {
      const need = caseCostUsd(input.prices, c) + (input.judge ? judgeCostUsd(input.prices) : 0);
      if (spent + need > input.capUsd) return { runs, metrics: metricsOf(runs), spentUsd: spent, stoppedByCap: true };
      spent += need;
      let outcome: Awaited<ReturnType<typeof runCase>>;
      try {
        outcome = await runCase(input.llm, c);
      } catch (err) {
        // Calls already made were paid for: hand them back so the script can still write them down.
        const aborted = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        return { runs, metrics: metricsOf(runs), spentUsd: spent, stoppedByCap: false, aborted };
      }
      let judge: RunRecord["judge"];
      if (input.judge && outcome.scenes.length) {
        try {
          judge = judgeScores(await input.judge(judgePrompt(c, outcome.scenes)), outcome.scenes) ?? undefined;
        } catch {
          judge = undefined;
        }
      }
      runs.push({ caseId: c.id, repeat, outcome, judge });
    }
  }
  return { runs, metrics: metricsOf(runs), spentUsd: spent, stoppedByCap: false };
}
