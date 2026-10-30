import { describe, expect, it } from "vitest";
import { refusal } from "@/server/jobs/redis";
import { draftArgs, NewVideo } from "@/server/schemas";

const run = "20261006-120000-abc001";

describe("the smooth-motion choice in a draft's command", () => {
  it("adds --fps 60 and nothing else for smooth motion, and nothing for the default", () => {
    expect(draftArgs(NewVideo.parse({ topic: "t" }), run, true)).not.toContain("--fps");
    const smooth = draftArgs(NewVideo.parse({ topic: "t", fps: 60 }), run, true);
    expect(smooth).toEqual(expect.arrayContaining(["--fps", "60"]));
    expect(refusal("runs", smooth)).toBeUndefined();
  });

  it("is a choice of 30 or 60 only, and an old recipe without it is the default", () => {
    expect(NewVideo.parse({ topic: "t" }).fps).toBe(30);
    for (const bad of [24, 59, 120, "60"]) expect(() => NewVideo.parse({ topic: "t", fps: bad })).toThrow();
  });

  it("goes with Full HD in one command", () => {
    const both = draftArgs(NewVideo.parse({ topic: "t", clips: "1080p", fps: 60 }), run, true);
    expect(both).toEqual(expect.arrayContaining(["--upscale", "--fps", "60"]));
    expect(refusal("runs", both)).toBeUndefined();
  });
});

describe("what the worker agrees to run", () => {
  const base = ["run", "--draft", "--yes", "--run-id", run, "--topic", "t"];
  it("takes --fps with exactly 60, once", () => {
    expect(refusal("runs", [...base, "--fps", "60"])).toBeUndefined();
    expect(refusal("runs", [...base, "--fps", "30"])).toMatch(/--fps/);
    expect(refusal("runs", [...base, "--fps", "60abc"])).toMatch(/--fps/);
    expect(refusal("runs", [...base, "--fps", "60", "--fps", "60"])).toBe("a draft may not repeat --fps");
    expect(refusal("runs", [...base, "--fps"])).toMatch(/--fps/);
  });
});
