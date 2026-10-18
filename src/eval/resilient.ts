import { TIMEOUTS, withRetry } from "../providers/retry.js";
import type { LlmProvider } from "../providers/types.js";

/**
 * The model calls of an eval, kept the way the script stage keeps its own: a timeout, and a retry of what a retry can
 * fix. Without it one 503 aborts the run, and an aborted run cannot be a baseline, so the owner would pay again.
 * `baseDelayMs` is a parameter so tests need not wait; the script passes none and gets the library's.
 */
export function resilientLlm(llm: Pick<LlmProvider, "generateScript">, baseDelayMs?: number): Pick<LlmProvider, "generateScript"> {
  return { generateScript: (req) => withRetry("script generation", () => llm.generateScript(req), { timeoutMs: TIMEOUTS.llmLong, baseDelayMs }) };
}

export function resilientJudge(judge: (prompt: string) => Promise<unknown>, baseDelayMs?: number): (prompt: string) => Promise<unknown> {
  return (prompt) => withRetry("judging", () => judge(prompt), { timeoutMs: TIMEOUTS.llmLong, baseDelayMs });
}
