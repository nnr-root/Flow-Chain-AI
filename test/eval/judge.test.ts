import { describe, expect, it } from "vitest";
import { CASES } from "../../src/eval/cases.js";
import { CRITERIA, judgePrompt, judgeScores, judgeSchema } from "../../src/eval/judge.js";

const scenes = [
  { narration: "One.", imagePrompt: "a lighthouse at dusk", motionPrompt: "a slow push-in", shot: "cut" },
  { narration: "Two.", imagePrompt: "the keeper on the stairs", motionPrompt: "the push-in continues", shot: "continue" },
];
const answer = { scores: { paintable: 4, plausible: 5, continuity: 3, flow: 4, fit: 5 }, notes: "ok" };

describe("the judge's question", () => {
  it("lists every scene, names every criterion, and sets the scale", () => {
    const p = judgePrompt(CASES[0], scenes);
    for (const c of CRITERIA) expect(p).toContain(c);
    expect(p).toContain("1 to 5");
    expect(p).toContain("a lighthouse at dusk");
    expect(p).toContain("the push-in continues");
  });
  it("does not ask about continuity where no scene continues another", () => {
    expect(judgePrompt(CASES[0], [scenes[0]])).toContain("continuity: null");
  });
  it("has a schema the model can answer", () => {
    expect(judgeSchema()).toHaveProperty("properties.scores");
  });
  it("has a schema without a null type, which the model's schema dialect may refuse", () => {
    expect(JSON.stringify(judgeSchema())).not.toContain('"null"');
  });
});

describe("the judge's answer", () => {
  it("gives the scores of a good answer", () => expect(judgeScores(answer, scenes)).toEqual(answer.scores));
  it("gives continuity as not applicable when no scene continues another, whatever was answered", () => {
    expect(judgeScores(answer, [scenes[0]])?.continuity).toBeNull();
  });
  it("takes an answer without continuity as a lost data point where scenes continue, not a failure", () => {
    const { continuity: _c, ...rest } = answer.scores;
    expect(judgeScores({ scores: rest, notes: "ok" }, scenes)).toEqual({ ...rest, continuity: null });
  });
  it("refuses an answer outside the scale or of the wrong shape", () => {
    expect(judgeScores({ ...answer, scores: { ...answer.scores, flow: 9 } }, scenes)).toBeNull();
    expect(judgeScores("nonsense", scenes)).toBeNull();
  });
});
