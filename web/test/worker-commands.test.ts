import { describe, expect, it } from "vitest";
import { refusal } from "@/server/jobs/redis";
import { draftArgs, rerenderArgs } from "@/server/schemas";

describe("what the worker agrees to run", () => {
  it("runs exactly the commands the studio sends", () => {
    const draft = draftArgs(
      { topic: "t", aspect: "9:16", scenes: 4, style: "auto", motion: "auto", provider: "fal", budgetUsd: 3, captionStyle: "preset", transition: "auto", musicGain: 0.35, sfxGain: 0.6, sfx: true, hook: { mode: "gemini" } } as Parameters<typeof draftArgs>[0],
      "20261006-120000-abc001",
    );
    expect(refusal("runs", draft)).toBeUndefined();
    expect(refusal("runs", draft, "20261006-120000-abc001")).toBeUndefined();
    expect(refusal("runs", ["resume", "x", "--budget", "1", "--cap", "1"], "x")).toBeUndefined();
    expect(refusal("runs", ["resume", "x", "--budget", "1", "--cap", "1"])).toBeUndefined();
    expect(refusal("runs", ["reroll", "x", "--scene", "1", "--stage", "clips", "--budget", "1", "--cap", "1"])).toBeUndefined();
    expect(refusal("runs", rerenderArgs("x", { captionStyle: "mrbeast" }))).toBeUndefined();
    expect(refusal("quick", ["plan", "x", "--json"])).toBeUndefined();
    expect(refusal("quick", ["draft-modes", "x", "--modes", "auto", "--json"])).toBeUndefined();
    expect(refusal("quick", rerenderArgs("x", { captionStyle: "mrbeast" }, "look"))).toBeUndefined();
  });

  it("refuses a full run, an unasked spend and anything that is not the studio's", () => {
    expect(refusal("runs", ["run", "--topic", "t", "--yes"])).toBe("a run may only be started as a draft");
    expect(refusal("runs", ["resume", "x", "--yes"])).toBe('"resume" may not be started with --yes');
    expect(refusal("runs", ["reroll", "x", "--scene", "1", "--stage", "clips", "--yes"])).toBe('"reroll" may not be started with --yes');
    expect(refusal("runs", ["doctor"])).toBe('"doctor" is not a job command');
    expect(refusal("quick", ["resume", "x"])).toBe('"resume" is not a quick command');
    expect(refusal("quick", ["rerender", "x"])).toBe('"rerender" is not a quick command');
    // a job works on its own run only
    expect(refusal("runs", ["resume", "y", "--budget", "1", "--cap", "1"], "x")).toBe("the command is for another run than the job");
    expect(refusal("runs", ["run", "--draft", "--yes", "--run-id", "y"], "x")).toBe("the command is for another run than the job");
    expect(refusal("runs", ["run", "--draft", "--yes"], "x")).toBe("the command is for another run than the job");
    expect(refusal("runs", [])).toBe("the job has no command");
    expect(refusal("runs", undefined)).toBe("the job has no command");
    expect(refusal("runs", ["resume", 1])).toBe("the job has no command");
  });
});
