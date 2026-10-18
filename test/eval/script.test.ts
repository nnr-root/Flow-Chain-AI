import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { CASES } from "../../src/eval/cases.js";
import { runEval } from "../../src/eval/driver.js";
import { FakeLlm, fakeScript } from "../fakes/providers.js";

const prices = Prices.parse({});
const one = CASES.filter((c) => c.id === "scene-count");

describe("an eval run", () => {
  it("runs every repeat of every case and judges each", async () => {
    const llm = new FakeLlm((req) => fakeScript(req.sceneCount));
    const judged: string[] = [];
    const out = await runEval({ llm, judge: async (p) => (judged.push(p), { scores: { paintable: 4, plausible: 4, continuity: 4, flow: 4, fit: 4 }, notes: "n" }), cases: one, repeats: 3, capUsd: 5, prices });
    expect(out.runs).toHaveLength(3);
    expect(judged).toHaveLength(3);
    expect(out.metrics.accepted.mean).toBe(1);
    expect(out.metrics["judge:flow"].mean).toBe(4);
  });

  it("stops before a call that would go past the cap", async () => {
    const llm = new FakeLlm((req) => fakeScript(req.sceneCount));
    const out = await runEval({ llm, judge: null, cases: one, repeats: 50, capUsd: 0.0001, prices });
    expect(out.runs.length).toBeLessThan(50);
    expect(out.stoppedByCap).toBe(true);
  });

  it("goes on without a score when the judge is away or answers badly", async () => {
    const llm = new FakeLlm((req) => fakeScript(req.sceneCount));
    const out = await runEval({ llm, judge: async () => "nonsense", cases: one, repeats: 1, capUsd: 5, prices });
    expect(out.runs).toHaveLength(1);
    expect(out.metrics["judge:flow"]).toBeUndefined();
  });
});
