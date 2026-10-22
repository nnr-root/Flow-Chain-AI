import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { comparable, consistency, keyframeLook, lookDistance, parseStats } from "../../src/eval/look.js";
import { makeImage, tempDir } from "../helpers/media.js";

const LOG = [
  "lavfi.signalstats.YLOW=40", "lavfi.signalstats.YAVG=120", "lavfi.signalstats.YHIGH=200",
  "lavfi.signalstats.UAVG=110", "lavfi.signalstats.VAVG=140", "lavfi.signalstats.SATAVG=51",
].join("\n");

describe("the look of a picture", () => {
  it("is read from ffmpeg's statistics as brightness, two colour axes, saturation and contrast, each from 0 to 1", () => {
    const look = parseStats(LOG);
    expect(look[0]).toBeCloseTo(120 / 255, 5);
    expect(look[1]).toBeCloseTo(110 / 255, 5);
    expect(look[2]).toBeCloseTo(140 / 255, 5);
    expect(look[3]).toBeCloseTo(51 / 255, 5);
    expect(look[4]).toBeCloseTo((200 - 40) / 255, 5);
  });

  it("refuses a log without the statistics, instead of reading zeros", () => {
    expect(() => parseStats("nothing here")).toThrow(/statistics/);
  });

  it("is the same for the same picture and different for pictures of different colours", async () => {
    const dir = await tempDir();
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    await makeImage(a, { width: 64, height: 64, color: "0x3366aa" });
    await makeImage(b, { width: 64, height: 64, color: "0xaa6633" });
    const [la, lb, la2] = [await keyframeLook(a), await keyframeLook(b), await keyframeLook(a)];
    expect(lookDistance(la, la2)).toBe(0);
    expect(lookDistance(la, lb)).toBeGreaterThan(0.05);
  });
});

describe("how alike a run's pictures look", () => {
  it("is the mean distance between neighbours, lower when they look alike, and 0 for fewer than two", () => {
    const a: [number, number, number, number, number] = [0.5, 0.4, 0.5, 0.2, 0.6];
    const b: [number, number, number, number, number] = [0.5, 0.4, 0.5, 0.2, 0.6];
    const c: [number, number, number, number, number] = [0.9, 0.2, 0.7, 0.5, 0.2];
    expect(consistency([a])).toBe(0);
    expect(consistency([a, b, a])).toBe(0);
    expect(consistency([a, c, a])).toBeGreaterThan(consistency([a, b, a]));
  });
});

describe("whether two runs can be compared", () => {
  const run = { keyframes: 6, profile: "runpod-flux3-klein@1", seed: 7 };

  it("accepts two runs of the same profile and seed with several keyframes each", () => {
    expect(comparable(run, { ...run })).toBeNull();
  });

  it("refuses a run with fewer than two keyframes, naming which", () => {
    expect(comparable({ ...run, keyframes: 1 }, run)).toMatch(/first run has 1 keyframe/);
    expect(comparable(run, { ...run, keyframes: 0 })).toMatch(/second run has 0 keyframes/);
  });

  it("refuses runs of another profile or another seed, which would not be the same script made two ways", () => {
    expect(comparable(run, { ...run, profile: "runpod-klein@1" })).toMatch(/picture model/);
    expect(comparable(run, { ...run, profile: undefined })).toMatch(/picture model/);
    expect(comparable(run, { ...run, seed: 8 })).toMatch(/seed/);
    expect(comparable(run, { ...run, seed: undefined })).toMatch(/seed/);
  });
});
