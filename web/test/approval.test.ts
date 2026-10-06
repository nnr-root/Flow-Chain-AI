import { describe, expect, it } from "vitest";
import { afterRefusal } from "@/lib/approval";

const estimate = { items: [], totalUsd: 0.31 };
const ask = { scene: 2, stage: "clips", label: "clip", totalUsd: 0.2 };

describe("what an estimate_changed refusal changes on screen", () => {
  it("a refused generate replaces the continue-run estimate and leaves the reroll dialog alone", () => {
    const next = afterRefusal("generate", 0.55, { estimate, ask });
    expect(next.estimate).toEqual({ items: [], totalUsd: 0.55 });
    expect(next.ask).toBe(ask);
  });

  it("a refused generate keeps the line items of the estimate it replaces", () => {
    const items = [{ stage: "tts" as const, scene: 1, costUsd: 0.1 }];
    expect(afterRefusal("generate", 0.55, { estimate: { items, totalUsd: 0.31 }, ask: null }).estimate?.items).toBe(items);
  });

  it("a refused reroll raises the dialog's amount and leaves the continue-run estimate alone", () => {
    const next = afterRefusal("reroll", 0.45, { estimate, ask });
    expect(next.ask).toEqual({ ...ask, totalUsd: 0.45 });
    expect(next.estimate).toBe(estimate);
  });

  it("a refused reroll with no dialog open does not invent one", () => {
    expect(afterRefusal("reroll", 0.45, { estimate, ask: null }).ask).toBeNull();
  });

  it("no other action changes either", () => {
    for (const action of ["modes", "stop", "unlock", "look", "rerender", "plan"] as const) {
      const next = afterRefusal(action, 9, { estimate, ask });
      expect(next.estimate).toBe(estimate);
      expect(next.ask).toBe(ask);
    }
  });
});
