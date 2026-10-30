import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLEY_RATES_MISSING, foleyRates, loadEnv, Prices, runpodRates } from "../../src/config.js";
import { soundEndpointId } from "../../src/doctor.js";
import { levelArgs } from "../../src/media/loudness.js";
import { movingInputArgs, soundInputSize, stillInputArgs } from "../../src/media/sound-input.js";
import { createProviders } from "../../src/providers/factory.js";
import { RUNPOD_WORKFLOWS, runpodModelId } from "../../src/providers/model-id.js";
import { newRunSound } from "../../src/providers/new-run.js";
import type { R2 } from "../../src/providers/r2.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { RunpodFoley, type RunpodDeps } from "../../src/providers/runpod-providers.js";
import {
  gainFor, guidanceFor, LOUDNESS_TARGET_LUFS, parseLoudness, SCENE_SOUND_MAX_SEC, SOUND_NEGATIVE_PROMPT, SOUND_STEPS, soundAskSeconds, soundCost, soundSeconds, soundSeed,
} from "../../src/sound.js";
import { FakeRunpodApi } from "../fakes/runpod.js";
import { tempDir } from "../helpers/media.js";

const RATES = { runpodFoleyUsdPerSec: 0.0003, runpodFoleySecPerClipSec: 4, runpodFoleyColdStartSec: 90 };

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

describe("the settings a scene's sound is asked with", () => {
  it("take guidance from the scene's action level, medium when it has none", () => {
    expect(guidanceFor("low")).toBe(3.5);
    expect(guidanceFor("medium")).toBe(4.5);
    expect(guidanceFor("high")).toBe(5.5);
    expect(guidanceFor(undefined)).toBe(4.5);
  });

  it("ask for the scene's length to a tenth of a second, and never more than the model's limit", () => {
    expect(SCENE_SOUND_MAX_SEC).toBe(10);
    expect(soundSeconds(12)).toBe(10);
    expect(soundSeconds(4.26)).toBe(4.3);
  });

  it("never ask the worker for less than the 1 s it makes, however short the scene", () => {
    expect(soundAskSeconds(0.4)).toBe(1);
    expect(soundAskSeconds(0.99)).toBe(1);
    expect(soundAskSeconds(1)).toBe(1);
    expect(soundAskSeconds(4.26)).toBe(4.3);
    expect(soundAskSeconds(12)).toBe(10);
  });

  it("always forbid speech and music, at a fixed number of steps", () => {
    expect(SOUND_NEGATIVE_PROMPT).toBe("speech, voice, vocals, singing, music, narration, noise, distortion");
    expect(SOUND_STEPS).toBe(50);
    expect(LOUDNESS_TARGET_LUFS).toBe(-26);
  });
});

describe("what a scene's sound costs", () => {
  it("is its seconds at the measured GPU seconds a second, with the worker's start on the first scene only", () => {
    const p = Prices.parse(RATES);
    expect(soundCost(p, 4, true)).toBe(0.0318);
    expect(soundCost(p, 4)).toBe(0.0048);
  });

  it("is refused plainly while any of the three rates is missing, never guessed", () => {
    expect(foleyRates(Prices.parse({}))).toBeUndefined();
    expect(foleyRates(Prices.parse({ ...RATES, runpodFoleyColdStartSec: undefined }))).toBeUndefined();
    expect(foleyRates(Prices.parse(RATES))).toEqual({ usdPerSec: 0.0003, secPerClipSec: 4, coldStartSec: 90 });
    expect(() => soundCost(Prices.parse({}), 4)).toThrow(FOLEY_RATES_MISSING);
    expect(() => Prices.parse({ ...RATES, runpodFoleyUsdPerSec: 0 })).toThrow();
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

describe("the small video the model is given", () => {
  it("is 480 on its short side, either way up, with even sides", () => {
    expect(soundInputSize(1080, 1920)).toEqual({ width: 480, height: 854 });
    expect(soundInputSize(1920, 1080)).toEqual({ width: 854, height: 480 });
    expect(soundInputSize(1088, 1920)).toEqual({ width: 480, height: 848 });
  });

  it("is a moving scene's fitted video, cut to the sound's length, at 24 fps and without sound", () => {
    const args = movingInputArgs("fitted.mp4", "in.mp4", { seconds: 4.3, width: 480, height: 854 });
    expect(args).toEqual([
      "-i", "fitted.mp4", "-t", "4.3", "-vf", "fps=24,scale=480:854,setsar=1", "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "in.mp4",
    ]);
  });

  it("is a slow zoom over a still scene's picture for the sound's length, at 24 fps and without sound", () => {
    const args = stillInputArgs("key.png", "in.mp4", { seconds: 4.3, width: 480, height: 848 });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("zoompan=z='min(zoom+0.0015,1.15)'");
    expect(vf).toContain(":d=103:s=480x848:fps=24");
    expect(args).toContain("-an");
    expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2)).toEqual(["-frames:v", "103"]);
    expect(args.slice(-9)).toEqual(["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "in.mp4"]);
  });
});

const env = (extra: Record<string, string> = {}) =>
  loadEnv({
    GEMINI_API_KEY: "g", RUNPOD_API_KEY: "rk", RUNPOD_CLIP_ENDPOINT: "cl1", RUNPOD_KEYFRAME_ENDPOINT: "kf1",
    R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s", ...extra,
  });

describe("whether a new run is made with scene sound", () => {
  const on = { FLOWCHAIN_SCENE_SOUND: "on", RUNPOD_FOLEY_ENDPOINT: "fo1" };

  it("is frozen on the Foley endpoint's model when the switch, the endpoint, the rates and the run's sound effects are all there", () => {
    expect(newRunSound(env(on), Prices.parse(RATES), true)).toEqual({ model: "runpod:fo1/sound-foley@1" });
    expect(RUNPOD_WORKFLOWS.sound).toEqual({ workflow: "sound-foley", version: 1 });
  });

  it("is off, and says nothing, in the ordinary cases: the switch off or the run without sound effects", () => {
    expect(loadEnv({ GEMINI_API_KEY: "g" }).FLOWCHAIN_SCENE_SOUND).toBe("off");
    expect(newRunSound(env(on), Prices.parse(RATES), false)).toEqual({});
    expect(newRunSound(env({ RUNPOD_FOLEY_ENDPOINT: "fo1" }), Prices.parse(RATES), true)).toEqual({});
    expect(newRunSound(env(), Prices.parse({}), true)).toEqual({});
  });

  it("is off, and says what is missing in plain words, when the switch is on without the endpoint or the prices", () => {
    const noEndpoint = newRunSound(env({ FLOWCHAIN_SCENE_SOUND: "on" }), Prices.parse(RATES), true);
    expect(noEndpoint).toEqual({ say: "scene sound is on but no sound endpoint is set; this run is made without it" });
    const noPrices = newRunSound(env(on), Prices.parse({}), true);
    expect(noPrices).toEqual({ say: "scene sound is on but its prices are not set; this run is made without it" });
    // (the line reaches a customer's job log: it names no setting, flag, model or provider)
    for (const said of [noEndpoint, noPrices]) expect((said as { say: string }).say).not.toMatch(/FLOWCHAIN_|RUNPOD|_ENDPOINT|--|prices\.json|runpodFoley/i);
  });
});

describe("the doctor's scene sound check", () => {
  it("checks the run's own Foley endpoint, or the one a new run would get while the switch is on, and none otherwise", () => {
    const models = { llm: "l", tts: "t", image: "i", video: "v" };
    expect(soundEndpointId(env(), { ...models, sound: "runpod:fo9/sound-foley@1" })).toBe("fo9");
    expect(soundEndpointId(env({ FLOWCHAIN_SCENE_SOUND: "on", RUNPOD_FOLEY_ENDPOINT: "fo1" }), models)).toBeUndefined();
    expect(soundEndpointId(env({ FLOWCHAIN_SCENE_SOUND: "on", RUNPOD_FOLEY_ENDPOINT: "fo1" }))).toBe("fo1");
    expect(soundEndpointId(env({ RUNPOD_FOLEY_ENDPOINT: "fo1" }))).toBeUndefined();
  });
});

afterEach(() => vi.unstubAllGlobals());

function deps(api: FakeRunpodApi): RunpodDeps {
  let t = 0;
  return { client: new RunpodClient("k", { fetch: api.fetch }), r2: {} as unknown as R2, rates: runpodRates(Prices.parse({})), poll: { pollMs: 1000, sleep: async (ms) => void (t += ms), now: () => t } };
}

describe("the request the Foley worker is sent", () => {
  it("carries the video, the prompts, the seed and the settings in the worker's own names", async () => {
    const dir = await tempDir();
    const clip = join(dir, "in.mp4");
    await writeFile(clip, Buffer.from("mp4-bytes"));
    const foley = new RunpodFoley(deps(new FakeRunpodApi(() => [])), { endpointId: "fo1", workflow: "sound-foley", version: 1 }, 0.0003);
    const req = { videoPath: clip, prompt: "surf on stone", negativePrompt: SOUND_NEGATIVE_PROMPT, seed: 77, guidanceScale: 4.5, steps: 50, audioLengthSec: 4.3 };
    expect((await foley.prepare(req)).input).toEqual({
      task: "sound", video: Buffer.from("mp4-bytes").toString("base64"), prompt: "surf on stone", negative_prompt: SOUND_NEGATIVE_PROMPT,
      seed: 77, guidance_scale: 4.5, steps: 50, audio_length: 4.3, workflow: "sound-foley@1",
    });
  });

  it("is charged its measured GPU seconds at the Foley rate", async () => {
    const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output: { url: "https://r2/k.wav", seed: 77 }, executionTime: 20_000 }]);
    vi.stubGlobal("fetch", api.fetch);
    const models = { llm: "l", tts: "t", image: runpodModelId("ep-k", "keyframe-klein", 1), video: runpodModelId("ep-c", "clip-wan22-480p", 1), sound: "runpod:fo1/sound-foley@1" };
    const p = createProviders(env(), models, Prices.parse(RATES));
    const id = await p.sound!.submit({ input: {} }, { signal: new AbortController().signal });
    const out = await p.sound!.wait(id, { timeoutMs: 60_000 });
    expect(out.costUsd).toBe(0.006);
    expect(out.seed).toBe(77);
  });

  it("is refused for a run made with scene sound while the rates are missing", () => {
    const models = { llm: "l", tts: "t", image: runpodModelId("ep-k", "keyframe-klein", 1), video: runpodModelId("ep-c", "clip-wan22-480p", 1), sound: "runpod:fo1/sound-foley@1" };
    expect(() => createProviders(env(), models, Prices.parse({}))).toThrow(FOLEY_RATES_MISSING);
    expect(createProviders(env(), { ...models, sound: undefined }, Prices.parse({})).sound).toBeUndefined();
  });
});
