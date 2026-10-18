import { describe, expect, it } from "vitest";
import { CASES } from "../../src/eval/cases.js";
import { runCase } from "../../src/eval/run.js";
import { sceneBounds, sceneWords, maxSceneUnits, totalWords, wordsPerSecond } from "../../src/duration.js";
import { validatePart } from "../../src/stages/script.js";
import { FakeLlm, fakeScript, timedScript } from "../fakes/providers.js";

const byId = (id: string) => CASES.find((c) => c.id === id)!;

describe("running an eval case", () => {
  it("counts an answer the pipeline's validators accept as accepted the first time", async () => {
    const llm = new FakeLlm((req) => fakeScript(req.sceneCount));
    const out = await runCase(llm, byId("scene-count"));
    expect(out.steps).toEqual([{ step: "script", accepted: true, problems: [], extra: [] }]);
    expect(out.scenes).toHaveLength(4);
    expect(llm.calls).toHaveLength(1);
  });

  it("counts a rejected answer as rejected, with the reasons, and does not ask again", async () => {
    const bad = fakeScript(4);
    bad.scenes[1].motionPrompt = "the keeper reaches for the lamp";
    const llm = new FakeLlm(() => bad);
    const out = await runCase(llm, byId("scene-count"));
    expect(out.steps[0].accepted).toBe(false);
    expect(out.steps[0].problems.join(" ")).toContain("scene 2 motionPrompt");
    expect(llm.calls).toHaveLength(1);
  });

  it("reports what the validators do not look at, even in an accepted answer", async () => {
    const answer = fakeScript(4);
    answer.hashtags = ["#fyp", "#a", "#b", "#c", "#d"];
    answer.scenes[2].imagePrompt = "a banner with text over the door";
    const out = await runCase(new FakeLlm(() => answer), byId("scene-count"));
    expect(out.steps[0].accepted).toBe(true);
    expect(out.steps[0].extra.map((f) => f.check).sort()).toEqual(["hashtag-generic", "text-asked"]);
  });

  it("asks a long video for its outline first, and stops at an outline that is rejected", async () => {
    const llm = new FakeLlm((req) => {
      const { scenes: _none, ...head } = fakeScript(1);
      return { ...head, parts: [{ summary: "only one part" }] };
    });
    const out = await runCase(llm, byId("parts-120"));
    expect(out.steps.map((s) => [s.step, s.accepted])).toEqual([["outline", false]]);
  });

  it("goes on through every part when each is accepted", async () => {
    const sec = { min: 3, max: 5 };
    const rate = wordsPerSecond("en", "narrator-m");
    const each = Math.round(totalWords(60, rate) / Math.round((sceneBounds(60, sec).min + sceneBounds(60, sec).max) / 2));
    const count = Math.round((sceneBounds(60, sec).min + sceneBounds(60, sec).max) / 2);
    const part = timedScript(Array(count).fill(each));
    // the fixture itself must be one the validator accepts, or this test says nothing
    expect(validatePart(part, 0, 60, sec, "en", "narrator-m", undefined, part.styleBible.setting).ok, "fixture").toBe(true);
    expect(sceneWords(sec, rate, maxSceneUnits("en", rate)).max).toBeGreaterThanOrEqual(each);
    const llm = new FakeLlm((req) => {
      if (req.ask?.kind === "outline") {
        const { scenes: _none, ...head } = fakeScript(1);
        return { ...head, parts: req.ask.partSec.map((_, i) => ({ summary: `part ${i + 1}` })) };
      }
      return { scenes: part.scenes };
    });
    const out = await runCase(llm, byId("parts-120"));
    expect(out.steps.map((s) => [s.step, s.accepted])).toEqual([["outline", true], ["part:1", true], ["part:2", true]]);
    expect(out.scenes).toHaveLength(count * 2);
  });

  it("checks a translation against the seconds of its scenes", async () => {
    const out = await runCase(new FakeLlm(() => ({ title: "t", hook: "Katzen heilen", narrations: ["eins"], hashtags: ["#a", "#b", "#c", "#d", "#e"] })), byId("translate-de"));
    expect(out.steps[0]).toMatchObject({ step: "translate", accepted: false });
  });
});
