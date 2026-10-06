import type { PlanJson } from "@src/studio/commands";

/** The paid or priced actions the studio sends; only `generate` and `reroll` can be refused with `estimate_changed`. */
export type ActionKind = "generate" | "reroll" | "modes" | "stop" | "unlock" | "look" | "rerender" | "plan";

/** What the screen shows an approval against: the continue-run estimate and the open reroll dialog, if any. */
export type Approvals<A extends { totalUsd: number }> = { estimate: PlanJson | null; ask: A | null };

/**
 * An `estimate_changed` refusal carries the new price of the action that was refused, so it belongs to that
 * action's figure alone: a generate's replaces the continue-run estimate, a reroll's replaces the dialog's amount.
 */
export function afterRefusal<A extends { totalUsd: number }>(action: ActionKind, totalUsd: number, now: Approvals<A>): Approvals<A> {
  if (action === "generate") return { estimate: { items: now.estimate?.items ?? [], totalUsd }, ask: now.ask };
  if (action === "reroll") return { estimate: now.estimate, ask: now.ask && { ...now.ask, totalUsd } };
  return now;
}
