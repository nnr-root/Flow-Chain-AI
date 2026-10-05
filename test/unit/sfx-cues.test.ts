import { describe, expect, it } from "vitest";
import type { Boundary } from "../../src/media/remotion/props.js";
import { sfxCues } from "../../src/media/sfx.js";

const cut = (frame: number, transition: Boundary["transition"]): Boundary => ({ frame, kind: "cut", transition, halfWindow: 5 });

describe("sfxCues", () => {
  it("plays an impact at frame 0 only when the hook is shown", () => {
    expect(sfxCues([], { hook: true, gain: 0.5 })).toEqual([{ sound: "impact", frame: 0, gain: 0.5 }]);
    expect(sfxCues([], { hook: false, gain: 0.5 })).toEqual([]);
  });

  it("whooshes into zoom and blur cuts (peak on the cut), pops on glitch and hard cuts, stays quiet on fades", () => {
    const cues = sfxCues(
      [cut(100, "zoom"), cut(200, "blur"), cut(300, "glitch"), cut(400, "cut"), cut(500, "fade"), cut(600, "dissolve")],
      { hook: false, gain: 1 },
    );
    expect(cues).toEqual([
      { sound: "whoosh", frame: 92, gain: 0.8 },
      { sound: "whoosh", frame: 192, gain: 0.8 },
      { sound: "pop", frame: 300, gain: 0.7 },
      { sound: "pop", frame: 400, gain: 0.7 },
    ]);
  });

  it("never plays at a continuity seam", () => {
    expect(sfxCues([{ frame: 100, kind: "seam", transition: "cut", halfWindow: 0 }], { hook: false, gain: 1 })).toEqual([]);
  });

  it("starts an early whoosh no earlier than frame 0", () => {
    expect(sfxCues([cut(3, "zoom")], { hook: false, gain: 1 })[0].frame).toBe(0);
  });
});
