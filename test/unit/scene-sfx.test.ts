import { describe, expect, it } from "vitest";
import { sceneSfxCues, type SfxCuePlan } from "../../src/media/sfx.js";

const s1 = { from: 0, frames: 90, lead: 0 };
const s2 = { from: 90, frames: 90, lead: 5 };
const o = { gain: 1, fps: 30 };
const frames = (r: SfxCuePlan[]) => r.map((c) => c.frame);

describe("sceneSfxCues (phase 12 spec §2)", () => {
  it("places a hit at the scene's start (after the lead-in), middle or last second", () => {
    const at = (a: "start" | "middle" | "end") =>
      sceneSfxCues([{ ...s1, cues: [{ sound: "door", at: a }] }, { ...s2, cues: [{ sound: "door", at: a }] }], [], o).map((c) => c.frame);
    expect(at("start")).toEqual([0, 95]);
    expect(at("middle")).toEqual([45, 135]);
    expect(at("end")).toEqual([60, 150]);
  });

  it("scales the gain by the sound's base gain", () => {
    const r = sceneSfxCues([{ ...s1, cues: [{ sound: "door", at: "start" }] }], [], { gain: 0.5, fps: 30 });
    expect(r[0].gain).toBeCloseTo(0.4, 9);
  });

  it("drops a hit within 5 frames of the edit's sound, keeps one 6 away, and widens the window at 60 fps", () => {
    const hit = (frame: number, fps: number, taken: number) =>
      sceneSfxCues([{ from: frame, frames: 200, lead: 0, cues: [{ sound: "door", at: "start" }] }], [{ sound: "pop", frame: taken, gain: 1 }], { gain: 1, fps });
    expect(hit(95, 30, 100)).toEqual([]);
    expect(hit(106, 30, 100)).toHaveLength(1);
    expect(hit(94, 30, 100)).toHaveLength(1);
    expect(hit(111, 60, 100)).toEqual([]);
    expect(hit(112, 60, 100)).toHaveLength(1);
  });

  it("collapses two cues of one name in a scene", () => {
    const r = sceneSfxCues([{ ...s1, cues: [{ sound: "door", at: "start" }, { sound: "door", at: "end" }] }], [], o);
    expect(frames(r)).toEqual([0]);
  });

  it("runs a bed under the rest of the scene, ignores `at`, is never dropped by a clash, and keeps only the first bed", () => {
    const r = sceneSfxCues(
      [{ ...s2, cues: [{ sound: "rain", at: "end" }, { sound: "wind", at: "start" }] }],
      [{ sound: "pop", frame: 95, gain: 1 }],
      o,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ sound: "rain", frame: 95, durationFrames: 85, fadeFrames: 15 });
    expect(r[0].gain).toBeCloseTo(0.25, 9);
  });

  it("shortens a bed's fade to half a very short scene, and scales it with the frame rate", () => {
    const short = sceneSfxCues([{ from: 0, frames: 20, lead: 0, cues: [{ sound: "rain", at: "start" }] }], [], o);
    expect(short[0].fadeFrames).toBe(10);
    const hi = sceneSfxCues([{ ...s1, frames: 180, cues: [{ sound: "rain", at: "start" }] }], [], { gain: 1, fps: 60 });
    expect(hi[0].fadeFrames).toBe(30);
  });

  it("yields nothing for a scene without cues, and sorts by frame", () => {
    expect(sceneSfxCues([{ ...s1, cues: [] }], [], o)).toEqual([]);
    const r = sceneSfxCues([{ ...s1, cues: [{ sound: "door", at: "end" }, { sound: "knock", at: "start" }] }], [], o);
    expect(frames(r)).toEqual([0, 60]);
  });

  it("floors the middle of an odd-length scene", () => {
    expect(frames(sceneSfxCues([{ ...s1, frames: 91, cues: [{ sound: "door", at: "middle" }] }], [], o))).toEqual([45]);
  });
});
