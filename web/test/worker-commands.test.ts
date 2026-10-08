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
    expect(refusal("runs", ["run", "--draft", "--yes"], "x")).toBe("a draft must begin: run --draft --yes --run-id <run>");
    expect(refusal("runs", [])).toBe("the job has no command");
    expect(refusal("runs", undefined)).toBe("the job has no command");
    expect(refusal("runs", ["resume", 1])).toBe("the job has no command");
  });

  it("holds a job to the kind it claims: the kind decides whether credit must be held for it", () => {
    expect(refusal("runs", ["resume", "x", "--budget", "100", "--cap", "100"], "x", "rerender")).toBe('a rerender job may not run "resume"');
    expect(refusal("runs", ["reroll", "x", "--scene", "1", "--stage", "clips", "--budget", "1", "--cap", "1"], "x", "generate")).toBe('a generate job may not run "reroll"');
    expect(refusal("runs", ["rerender", "x"], "x", "draft")).toBe('a draft job may not run "rerender"');
    expect(refusal("runs", ["resume", "x", "--budget", "1", "--cap", "1"], "x", "generate")).toBeUndefined();
    expect(refusal("runs", ["rerender", "x"], "x", "rerender")).toBeUndefined();
  });

  it("takes a spending command only in exactly the studio's shape: a command line reads the LAST of two caps", () => {
    const shape = '"resume" must be: resume <run> --budget <usd> --cap <the same usd>';
    for (const args of [
      ["resume", "x", "--budget", "0.5", "--cap", "0.5", "--cap", "500"], // a second cap after the one that was checked
      ["resume", "x", "--cap", "0.5", "--budget", "0.5"],
      ["resume", "x", "--budget", "0.5", "--cap=500"],
      ["resume", "x", "--budget", "500", "--cap", "0.5"], // budget and cap must be one amount
      ["resume", "x", "--budget", "0.5", "--cap", "0.5", "--from", "script"],
      ["resume", "x", "--budget", "-1", "--cap", "-1"],
      ["resume", "x", "--budget", "1e3", "--cap", "1e3"],
      ["resume", "x", "--"],
    ]) {
      expect(refusal("runs", args, "x"), args.join(" ")).toBe(shape);
    }
    const reroll = '"reroll" must be: reroll <run> --scene <n> --stage <name> --budget <usd> --cap <the same usd>';
    expect(refusal("runs", ["reroll", "x", "--scene", "1", "--stage", "clips", "--budget", "1", "--cap", "1", "--cap", "9"], "x")).toBe(reroll);
    expect(refusal("runs", ["reroll", "x", "--scene", "1; rm -rf /", "--stage", "clips", "--budget", "1", "--cap", "1"], "x")).toBe(reroll);
    expect(refusal("runs", ["reroll", "x", "--stage", "clips", "--scene", "1", "--budget", "1", "--cap", "1"], "x")).toBe(reroll);
    // bare, a resume can spend nothing: the CLI stops to ask
    expect(refusal("runs", ["resume", "x"], "x")).toBeUndefined();
  });

  it("lets a draft carry only what a draft has, each once: a second --run-id would write into another run", () => {
    const start = ["run", "--draft", "--yes", "--run-id", "x"];
    expect(refusal("runs", [...start, "--topic", "t", "--run-id", "y"], "x")).toBe("a draft may not carry --run-id");
    expect(refusal("runs", [...start, "--topic", "one", "--topic", "two"], "x")).toBe("a draft may not repeat --topic");
    expect(refusal("runs", [...start, "--from", "script"], "x")).toBe("a draft may not carry --from");
    expect(refusal("runs", [...start, "--topic"], "x")).toBe("a draft may not carry --topic");
    expect(refusal("runs", ["run", "--yes", "--draft", "--run-id", "x"], "x")).toBe("a draft must begin: run --draft --yes --run-id <run>");
    // what follows an option is its value, whatever it looks like: a topic that reads like an option is still a topic
    expect(refusal("runs", [...start, "--topic", "--run-id", "--hook", "--yes", "--no-sfx"], "x")).toBeUndefined();
  });
});
