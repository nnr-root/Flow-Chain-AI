import { describe, expect, it } from "vitest";
import { levelArgs } from "../../src/media/loudness.js";
import { parseModelId } from "../../src/providers/model-id.js";
import { gainFor, LOUDNESS_TARGET_LUFS, parseLoudness, RETIRED_SOUND_ENGINE, soundSeed } from "../../src/sound.js";

describe("a scene's sound seed", () => {
  it("is the same for the same run, scene and reroll", () => {
    expect(soundSeed(1234, 2, 0)).toBe(soundSeed(1234, 2, 0));
  });

  it("differs between the scenes of one run, after a reroll, and in another run", () => {
    const seeds = [0, 1, 2, 3].map((i) => soundSeed(1234, i, 0));
    expect(new Set(seeds).size).toBe(4);
    expect(soundSeed(1234, 2, 1)).not.toBe(soundSeed(1234, 2, 0));
    expect(soundSeed(1235, 2, 0)).not.toBe(soundSeed(1234, 2, 0));
  });

  it("is always a seed the worker takes: 0 to 2^31 - 1", () => {
    for (let i = 0; i < 500; i++) {
      const s = soundSeed(i * 7919, i % 13, i % 3);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });
});

describe("the loudness a scene's sound is levelled to", () => {
  it("is one target for every scene", () => {
    expect(LOUDNESS_TARGET_LUFS).toBe(-26);
  });
});

// recorded from `ffmpeg -i x.wav -af ebur128 -f null -` (ffmpeg 8.1.2), a 3 s sine at -6 dB
const EBUR128 = `[Parsed_ebur128_0 @ 0x7b90c48900] t: 2.999979   TARGET:-23 LUFS    M: -27.8 S: -27.8     I: -27.8 LUFS       LRA:  20.0 LU
[Parsed_ebur128_0 @ 0x7b90c48900] Summary:

  Integrated loudness:
    I:         -27.8 LUFS
    Threshold: -37.8 LUFS

  Loudness range:
    LRA:        20.0 LU
    Threshold: -47.8 LUFS
    LRA low:   -47.8 LUFS
    LRA high:  -27.8 LUFS
[out#0/null @ 0x7b90c48180] video:0KiB audio:281KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown`;

describe("levelling a scene's sound", () => {
  it("reads the integrated loudness from the summary, not from a running line", () => {
    expect(parseLoudness(EBUR128.replace("I:         -27.8", "I:         -31.4"))).toBe(-31.4);
    expect(parseLoudness(EBUR128)).toBe(-27.8);
  });

  it("finds nothing in text without a summary", () => {
    expect(parseLoudness("t: 2.9 M: -27.8 S: -27.8 I: -27.8 LUFS")).toBeUndefined();
    expect(parseLoudness("")).toBeUndefined();
  });

  it("is a gain from what was measured to the target, within 30 dB either way", () => {
    expect(gainFor(-40)).toBe(14);
    expect(gainFor(-10)).toBe(-16);
    expect(gainFor(-90)).toBe(30);
    expect(gainFor(20)).toBe(-30);
    expect(gainFor(-30, -20)).toBe(10);
  });

  it("applies the gain under a limiter that does not level the result again, and fades a track cut at the limit", () => {
    const plain = levelArgs("in.wav", "out.wav", { gainDb: 3.2, seconds: 4.3, fadeOut: false });
    const filter = plain[plain.indexOf("-af") + 1];
    // (alimiter levels its output by default, which undoes the gain: measured -24 instead of -26 LUFS on 2026-10-31)
    expect(filter).toBe("atrim=0:4.3,volume=3.2dB,alimiter=limit=0.8:level=false");
    expect(plain.slice(-5)).toEqual(["-ar", "48000", "-ac", "1", "out.wav"]);
    const cut = levelArgs("in.wav", "out.wav", { gainDb: -1, seconds: 10, fadeOut: true });
    expect(cut[cut.indexOf("-af") + 1]).toBe("atrim=0:10,afade=t=out:st=9.5:d=0.5,volume=-1dB,alimiter=limit=0.8:level=false");
  });
});

describe("a run made with the scene-sound worker that was removed (phase 15 spec §13.12)", () => {
  it("has its sound model parsed as retired, whatever its endpoint", () => {
    expect(parseModelId("runpod:fo1/sound-foley@1")).toEqual({ provider: "retired", model: "runpod:fo1/sound-foley@1" });
    expect(parseModelId("runpod:other/sound-foley@2")).toEqual({ provider: "retired", model: "runpod:other/sound-foley@2" });
  });

  it("is told, when a sound would have to be bought for it, in words that name no model, provider or setting", () => {
    expect(RETIRED_SOUND_ENGINE).toBe("this run's scene sounds came from a sound engine this studio no longer uses; it can be re-rendered, but no sound can be bought for it");
    expect(RETIRED_SOUND_ENGINE).not.toMatch(/foley|hunyuan|runpod|FLOWCHAIN_|_ENDPOINT|prices\.json/i);
  });
});
