import { describe, expect, it } from "vitest";
import { commandKind, refusal } from "@/server/jobs/redis";
import { draftArgs, NewVideo, rerenderArgs } from "@/server/schemas";

describe("what the worker agrees to run", () => {
  it("runs exactly the commands the studio sends", () => {
    const draft = draftArgs(
      { topic: "t", aspect: "9:16", durationSec: 30, sceneSec: { min: 3, max: 5 }, language: "en", style: "auto", motion: "auto", clips: "480p", captionStyle: "preset", transition: "auto", musicGain: 0.35, sfxGain: 0.6, sfx: true, hook: { mode: "auto" } } as Parameters<typeof draftArgs>[0],
      "20261006-120000-abc001",
    );
    expect(refusal("runs", draft)).toBeUndefined();
    // a draft is asked for by its length; a number of scenes is not something the studio sends
    expect(draft).toEqual(expect.arrayContaining(["--duration", "30", "--scene-seconds", "3-5"]));
    expect(refusal("runs", [...draft, "--scenes", "4"])).toBeTruthy();
    expect(refusal("runs", [...draft, "--duration", "600"])).toBeTruthy();
    expect(refusal("runs", draft, "20261006-120000-abc001")).toBeUndefined();
    // a niche (phase 7 spec §19): one the studio knows, or one in the user's words, as the one value it is
    const withNiche = (niche: object) => draftArgs({ ...(NewVideo.parse({ topic: "t", niche })) }, "20261006-120000-abc001");
    expect(withNiche({ kind: "known", id: "history" })).toEqual(expect.arrayContaining(["--niche", "history"]));
    expect(withNiche({ kind: "custom", text: "Cozy cat facts --budget 9" })).toEqual(expect.arrayContaining(["--niche-text", "Cozy cat facts --budget 9"]));
    for (const niche of [{ kind: "known", id: "history" }, { kind: "custom", text: "--cap 5" }]) expect(refusal("runs", withNiche(niche)), JSON.stringify(niche)).toBeUndefined();
    expect(withNiche({ kind: "none" })).not.toContain("--niche");
    expect(() => NewVideo.parse({ topic: "t", niche: { kind: "custom", text: "two\nlines" } })).toThrow();
    expect(() => NewVideo.parse({ topic: "t", niche: { kind: "known", id: "medicine" } })).toThrow();
    // a type, an edit and a video not made for its language's viewers (phase 8 spec): each the one value it is
    const layered = draftArgs(NewVideo.parse({ topic: "t", language: "ja", format: "countdown", edit: "retro", localize: false }), "20261006-120000-abc001");
    expect(layered).toEqual(expect.arrayContaining(["--format", "countdown", "--edit", "retro", "--no-localize"]));
    expect(refusal("runs", layered)).toBeUndefined();
    expect(refusal("runs", [...layered, "--format", "pov"])).toBe("a draft may not repeat --format");
    // made for its viewers unless asked not to, and nothing said of it then
    expect(draftArgs(NewVideo.parse({ topic: "t", language: "ja" }), "x")).not.toContain("--no-localize");
    expect(() => NewVideo.parse({ topic: "t", format: "vlog" })).toThrow();
    expect(refusal("runs", ["resume", "x", "--budget", "1", "--cap", "1"], "x")).toBeUndefined();
    expect(refusal("runs", ["resume", "x", "--budget", "1", "--cap", "1"])).toBeUndefined();
    expect(refusal("runs", ["reroll", "x", "--scene", "1", "--stage", "clips", "--budget", "1", "--cap", "1"])).toBeUndefined();
    expect(refusal("runs", rerenderArgs("x", { captionStyle: "mrbeast" }))).toBeUndefined();
    expect(refusal("quick", ["plan", "x", "--json"])).toBeUndefined();
    expect(refusal("quick", ["draft-modes", "x", "--modes", "auto", "--json"])).toBeUndefined();
    expect(refusal("quick", rerenderArgs("x", { captionStyle: "mrbeast" }, "look"))).toBeUndefined();
  });

  it("runs a version in another language only in the exact shape the studio sends, for the job's own new run", () => {
    const [source, fresh] = ["20261006-120000-abc001", "20261006-120000-abc002"];
    const ok = ["translate", source, "--language", "tr", "--voice", "narrator-m", "--run-id", fresh, "--budget", "0.03", "--cap", "0.03"];
    expect(commandKind(ok)).toBe("generate");
    expect(refusal("runs", ok, fresh, "generate")).toBeUndefined();
    // the job's run is the new one; the source is only read, and is a run id, never a path
    expect(refusal("runs", ok, source, "generate")).toBe("the command is for another run than the job");
    for (const bad of [
      [...ok, "--yes"],
      ok.map((a) => (a === source ? "../other-user/20261006-120000-abc001" : a)),
      ok.map((a, i) => (i === 7 ? source : a)),
      ok.map((a, i) => (i === 11 ? "9" : a)),
      ok.map((a, i) => (i === 3 ? "../x" : a)),
      ok.map((a, i) => (i === 5 ? "--cap" : a)),
      ok.slice(0, 10),
    ]) expect(refusal("runs", bad, fresh, "generate"), JSON.stringify(bad)).toBeTruthy();
    // and it is a job that spends: never a free one
    expect(refusal("runs", ok, fresh, "rerender")).toBe('a rerender job may not run "translate"');
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
    // bare, a resume would spend up to the CLI's own default budget with no cap at all
    expect(refusal("runs", ["resume", "x"], "x")).toBe(shape);
    expect(commandKind(["resume", "x"])).toBe("generate");
    expect(commandKind(["run", "--draft"])).toBe("draft");
    expect(commandKind(["doctor"])).toBeUndefined();
    expect(commandKind(undefined)).toBeUndefined();
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
