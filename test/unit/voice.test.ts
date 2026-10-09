import { describe, expect, it } from "vitest";
import { loadEnv, Prices, runpodRates } from "../../src/config.js";
import { createProviders } from "../../src/providers/factory.js";
import { newRunVoice } from "../../src/providers/new-run.js";
import { NonRetryableError, UnusableResultError } from "../../src/providers/retry.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { RunpodTts } from "../../src/providers/runpod-voice.js";
import { alignWords, fold, heardShare } from "../../src/voice/align.js";
import { speechLanguage } from "../../src/voice/language.js";
import { FakeRunpodApi } from "../fakes/runpod.js";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("laying a script's words over what was heard", () => {
  it("gives a word that was heard as written its own time", () => {
    const heard = [w("Most", 0.1, 0.4), w("product", 0.45, 0.9), w("photos", 0.95, 1.4), w("fail.", 1.5, 1.9)];
    expect(alignWords("Most product photos fail.", heard, 2.2)).toEqual([w("Most", 0.1, 0.4), w("product", 0.45, 0.9), w("photos", 0.95, 1.4), w("fail.", 1.5, 1.9)]);
  });

  it("keeps the script's own spelling and punctuation, whatever the listener wrote", () => {
    const heard = [w("the", 0, 0.2), w("clock-maker's", 0.2, 0.9), w("RULE", 0.9, 1.3)];
    expect(alignWords("The clockmaker’s rule:", heard, 1.5).map((x) => x.text)).toEqual(["The", "clockmaker’s", "rule:"]);
    expect(alignWords("The clockmaker’s rule:", heard, 1.5)[2]).toEqual(w("rule:", 0.9, 1.3));
  });

  it("lets a number the voice read out as several words take the time between its neighbours", () => {
    // "2026" was spoken as four words: the script's one word spans them
    const heard = [w("In", 0, 0.2), w("twenty", 0.25, 0.6), w("twenty", 0.6, 0.95), w("six,", 0.95, 1.4), w("three", 1.5, 1.8), w("shoppers", 1.8, 2.4)];
    const out = alignWords("In 2026, three shoppers", heard, 2.5);
    expect(out[0]).toEqual(w("In", 0, 0.2));
    expect(out[1]).toEqual(w("2026,", 0.2, 1.5));
    expect(out.slice(2)).toEqual([w("three", 1.5, 1.8), w("shoppers", 1.8, 2.4)]);
  });

  it("shares a stretch that was misheard among its words by their length", () => {
    const heard = [w("So", 0, 0.2), w("hayatoglu", 0.3, 1.1), w("left", 1.2, 1.5)];
    const out = alignWords("So Aya Togu left", heard, 1.6);
    expect(out.map((x) => x.text)).toEqual(["So", "Aya", "Togu", "left"]);
    // 3 and 4 letters share the second from 0.2 to 1.2
    expect(out[1]).toEqual(w("Aya", 0.2, 0.629));
    expect(out[2]).toEqual(w("Togu", 0.629, 1.2));
    expect(out[3]).toEqual(w("left", 1.2, 1.5));
  });

  it("matches Turkish words whatever the listener did with their dots and capitals", () => {
    expect(fold("İLK")).toBe(fold("ilk"));
    expect(fold("Işık")).toBe(fold("isik"));
    expect(fold("çırağıydı.")).toBe("ciragiydi");
    const heard = [w("Ürün", 0.1, 0.5), w("fotoğraflarının", 0.5, 1.3), w("Çoğu", 1.3, 1.6), w("ILK", 1.7, 1.9), w("saniyede", 1.9, 2.5)];
    expect(alignWords("ürün fotoğraflarının çoğu ilk saniyede", heard, 2.6).map((x) => [x.start, x.end])).toEqual([[0.1, 0.5], [0.5, 1.3], [1.3, 1.6], [1.7, 1.9], [1.9, 2.5]]);
  });

  it("always gives every word a time, in order, inside the clip", () => {
    const cases: Array<[string, ReturnType<typeof w>[], number]> = [
      ["nothing was heard at all here", [], 3],
      ["one", [w("one", 5, 9)], 2],
      ["times that run backwards", [w("times", 1, 0.5), w("that", 0.2, 0.3), w("backwards", 0.1, 0.2)], 1.5],
      ["heard far more than was written", Array.from({ length: 30 }, (_, i) => w(i % 5 === 0 ? "heard" : "noise", i * 0.1, i * 0.1 + 0.08)), 3.2],
      ["a b c d e f g h", [w("h", 2.5, 2.9)], 3],
    ];
    for (const [text, heard, seconds] of cases) {
      const out = alignWords(text, heard, seconds);
      expect(out.map((x) => x.text), text).toEqual(text.split(" "));
      let last = 0;
      for (const word of out) {
        expect(word.start, text).toBeGreaterThanOrEqual(last);
        expect(word.end, text).toBeGreaterThanOrEqual(word.start);
        expect(word.end, text).toBeLessThanOrEqual(seconds);
        last = word.end;
      }
    }
    // with nothing heard the words fill the clip, so captions still move
    expect(alignWords("ab cd", [], 2)).toEqual([w("ab", 0, 1), w("cd", 1, 2)]);
    expect(alignWords("  ", [w("x", 0, 1)], 2)).toEqual([]);
  });

  it("tells a clip that spoke its line from one that said something else", () => {
    expect(heardShare("Most product photos fail", [w("most", 0, 1), w("product", 1, 2), w("photos", 2, 3), w("fail", 3, 4)])).toBe(1);
    expect(heardShare("In 2026 three shoppers decide", [w("in", 0, 1), w("twenty", 1, 2), w("three", 2, 3), w("shoppers", 3, 4), w("decide", 4, 5)])).toBe(0.8);
    expect(heardShare("Most product photos fail", [w("thank", 0, 1), w("you", 1, 2), w("for", 2, 3), w("watching", 3, 4)])).toBe(0);
    // a word said once does not count for the two times it was written
    expect(heardShare("go go go", [w("go", 0, 1)])).toBeCloseTo(1 / 3);
  });
});

describe("which reference clip a script is spoken from", () => {
  it("knows Turkish and English, and says nothing when it is neither clearly", () => {
    expect(speechLanguage("Yaşlı saatçinin tek bir kuralı vardı: hava karardıktan sonra kule saatine asla dokunma.")).toBe("tr");
    expect(speechLanguage("Bu video cok iyi ve bir de ucuz")).toBe("tr"); // typed without Turkish letters
    expect(speechLanguage("The old clockmaker had one rule: never touch the tower clock after dark.")).toBe("en");
    // an English script with a Turkish name in it is English
    expect(speechLanguage("The story of Ayşe and the light that was alive is one of the oldest in the town.")).toBe("en");
    expect(speechLanguage("Der alte Uhrmacher hatte eine Regel.")).toBeUndefined();
    expect(speechLanguage("12345 !!!")).toBeUndefined();
  });
});

describe("the studio's own voice", () => {
  const target = { endpointId: "ep-v", workflow: "voice-voxcpm2", version: 1 };
  const speech = Buffer.from("mp3-bytes").toString("base64");
  const heard = [w("Most", 0.1, 0.4), w("photos", 0.5, 0.9), w("fail", 1, 1.4)];
  const done = (words = heard, executionTime = 4000) => ({ status: "COMPLETED" as const, executionTime, output: { audio: speech, words, seconds: 1.6, sampleRate: 48000, executionMs: 3900 } });
  const voice = (api: FakeRunpodApi) => new RunpodTts({ client: new RunpodClient("rk", { fetch: api.fetch }), usdPerSec: 0.000306, poll: { pollMs: 1, sleep: async () => {} } }, target);
  const req = { text: "Most photos fail", voiceId: "narrator-f", language: "en", previousText: "before", nextText: "after" };

  it("sends one line with its voice and language, and returns the speech, the script's words timed, and what the GPU cost", async () => {
    const api = new FakeRunpodApi(() => [{ status: "IN_QUEUE" }, { status: "IN_PROGRESS" }, done()]);
    const out = await voice(api).speak(req);
    expect(out.audio.toString()).toBe("mp3-bytes");
    expect(out.words).toEqual([w("Most", 0.1, 0.4), w("photos", 0.5, 0.9), w("fail", 1, 1.4)]);
    expect(out.costUsd).toBe(0.0012); // 4 s at $0.000306
    expect(api.runs).toHaveLength(1);
    // only the line itself travels: the lines around it stay here
    expect(api.runs[0]).toMatchObject({ endpointId: "ep-v", input: { task: "speak", workflow: "voice-voxcpm2@1", text: "Most photos fail", voice: "narrator-f", language: "en", seed: 42 } });
    expect(Object.keys(api.runs[0].input).sort()).toEqual(["language", "seed", "task", "text", "voice", "workflow"]);
    expect(api.runs[0].policy).toEqual({ executionTimeout: 120_000, ttl: 3_600_000 });
  });

  it("leaves the language out when it is not known: the worker listens for it", async () => {
    const api = new FakeRunpodApi(() => [done()]);
    await voice(api).speak({ text: "Most photos fail", voiceId: "narrator-m" });
    expect(api.runs[0].input).not.toHaveProperty("language");
  });

  it("asks once more, with another seed, for a line the voice did not speak, and counts both tries", async () => {
    const wrong = [w("thank", 0, 0.5), w("you", 0.5, 1)];
    const api = new FakeRunpodApi((_input, n) => [n === 1 ? done(wrong, 3000) : done(heard, 4000)]);
    const out = await voice(api).speak(req);
    expect(api.runs.map((r) => r.input.seed)).toEqual([42, 1337]);
    expect(out.costUsd).toBe(0.0021);
    // and gives up after the second, saying what it cost: never a third paid try on its own
    const never = new FakeRunpodApi(() => [done(wrong, 3000)]);
    const failed = await voice(never).speak(req).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(UnusableResultError);
    expect((failed as UnusableResultError).costUsd).toBe(0.0018);
    expect(never.runs).toHaveLength(2);
  });

  it("never buys a job again after one was bought: a failure, a refusal and a job that vanished are final", async () => {
    const cases: Array<[FakeRunpodApi, RegExp]> = [
      [new FakeRunpodApi(() => [{ status: "FAILED", executionTime: 2000, error: "CUDA out of memory" }]), /voice job job-1 failed/],
      [new FakeRunpodApi(() => [{ status: "TIMED_OUT" }]), /timed out/],
      [new FakeRunpodApi(() => [{ status: "COMPLETED", executionTime: 10, output: { error: "invalid request: voice must be one of narrator-f, narrator-m" } }]), /refused the line: invalid request/],
      [new FakeRunpodApi(() => [{ status: "COMPLETED", executionTime: 10, output: { words: [] } }]), /completed without speech/],
    ];
    for (const [api, message] of cases) {
      const err = await voice(api).speak(req).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect((err as Error).message).toMatch(message);
      expect(api.runs).toHaveLength(1);
    }
    const gone = new FakeRunpodApi(() => [{ status: "IN_QUEUE" }]);
    const tts = voice(gone);
    const pending = tts.speak(req).catch((e: unknown) => e);
    gone.expire("job-1");
    expect(await pending).toBeInstanceOf(NonRetryableError);
    // a provider's own words about a failed job are not passed on
    const failed = await voice(new FakeRunpodApi(() => [{ status: "FAILED", executionTime: 2000, error: "CUDA out of memory at 0x7f" }])).speak(req).catch((e: Error) => e.message);
    expect(failed).not.toContain("CUDA");
  });

  it("stops waiting after ten minutes without buying anything more", async () => {
    let clock = 0;
    const api = new FakeRunpodApi(() => [{ status: "IN_QUEUE" }]);
    const tts = new RunpodTts({ client: new RunpodClient("rk", { fetch: api.fetch }), usdPerSec: 0.000306, poll: { pollMs: 60_000, sleep: async (ms) => void (clock += ms), now: () => clock } }, target);
    await expect(tts.speak(req)).rejects.toThrow("was not finished after 10 minutes");
    expect(api.runs).toHaveLength(1);
  });
});

describe("which voice a new run gets", () => {
  const base = { GEMINI_API_KEY: "g" };
  it("the studio's own once its endpoint is set up, and the hosted one until then", () => {
    expect(newRunVoice(loadEnv({ ...base, RUNPOD_VOICE_ENDPOINT: "ep-v" }))).toEqual({ model: "runpod:ep-v/voice-voxcpm2@1", voiceId: "narrator-m" });
    expect(newRunVoice(loadEnv({ ...base, RUNPOD_VOICE_ENDPOINT: "ep-v", FLOWCHAIN_VOICE: "narrator-f", ELEVENLABS_API_KEY: "e", ELEVENLABS_VOICE_ID: "v" }))).toEqual({ model: "runpod:ep-v/voice-voxcpm2@1", voiceId: "narrator-f" });
    expect(newRunVoice(loadEnv({ ...base, ELEVENLABS_API_KEY: "e", ELEVENLABS_VOICE_ID: "v" }))).toEqual({ model: "eleven_multilingual_v2", voiceId: "v" });
    expect(() => newRunVoice(loadEnv(base))).toThrow("no voice is set up");
    expect(() => loadEnv({ ...base, FLOWCHAIN_VOICE: "../x" })).toThrow();
  });

  it("keeps each run on the voice it was made with", () => {
    const env = loadEnv({ ...base, RUNPOD_API_KEY: "rk", RUNPOD_VOICE_ENDPOINT: "ep-new", ELEVENLABS_API_KEY: "e", ELEVENLABS_VOICE_ID: "v" });
    const prices = Prices.parse({});
    const own = createProviders(env, { llm: "l", tts: "runpod:ep-old/voice-voxcpm2@1", image: "fal-ai/flux/dev", video: "fal-ai/kling" }, prices);
    expect(own.tts).toBeInstanceOf(RunpodTts);
    const hosted = createProviders(env, { llm: "l", tts: "eleven_multilingual_v2", image: "fal-ai/flux/dev", video: "fal-ai/kling" }, prices);
    expect(hosted.tts).not.toBeInstanceOf(RunpodTts);
    // a run on the hosted voice needs that service's key, and says so
    expect(() => createProviders(loadEnv({ ...base, RUNPOD_API_KEY: "rk" }), { llm: "l", tts: "eleven_multilingual_v2", image: "fal-ai/flux/dev", video: "fal-ai/kling" }, prices)).toThrow("ELEVENLABS_API_KEY is not set");
    expect(runpodRates(prices)).toMatchObject({ voiceUsdPerSec: 0.000306, voiceSecPerLine: 3, voiceSecPerChar: 0.02, voiceColdStartSec: 40 });
  });
});
