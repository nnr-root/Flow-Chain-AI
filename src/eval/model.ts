/** The environment without the variables that are set to nothing: `GEMINI_MODEL=` from an empty `.env` line must fall back to the default, not become a model with no name. */
export function withoutEmpty(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

/** A line to print when the baseline was judged by another model than this run: the two sets of scores cannot be compared. */
export function modelMismatch(baselineModel: string | undefined, currentModel: string): string | null {
  if (!baselineModel || baselineModel === currentModel) return null;
  return `the baseline was judged by ${baselineModel}, this run by ${currentModel}: scores are not comparable`;
}
