import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ElevenLabsTts, wordsFromAlignment } from "../../src/providers/elevenlabs.js";
import { FalImage, type FalLike, FalVideo } from "../../src/providers/fal.js";
import { HttpError, isRetryable, NonRetryableError, UnusableResultError } from "../../src/providers/retry.js";
import { buildScriptPrompt, scriptJsonSchema } from "../../src/providers/gemini.js";
import { PRESETS } from "../../src/presets.js";

describe("gemini prompt and schema", () => {
  it("asks for the exact scene count and word cap", () => {
    const p = buildScriptPrompt({ topic: "octopus intelligence", sceneCount: 5, aspect: "9:16" });
    expect(p).toContain('"octopus intelligence"');
    expect(p).toContain("exactly 5 scenes");
    expect(p).toContain("at most 22 words");
    expect(p).toContain("vertical 9:16");
    expect(p).not.toContain("rejected");
  });

  it("pins the shot values when the run fixes them", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 3, aspect: "9:16", shots: ["cut", "continue", "continue"] });
    expect(p).toContain('Use exactly these shot values, in order: scene 1 "cut", scene 2 "continue", scene 3 "continue"');
    expect(buildScriptPrompt({ topic: "t", sceneCount: 3, aspect: "9:16" })).not.toContain("Use exactly these shot values");
  });

  it("lists the style presets and lets Gemini pick one, or pins --style", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16" });
    for (const preset of Object.values(PRESETS)) expect(p).toContain(`- ${preset.name}: ${preset.description}`);
    expect(p).toContain("stylePreset: set it to the preset that best fits the topic");
    const pinned = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16", style: "anime" });
    expect(pinned).toContain('stylePreset: use exactly "anime"');
    expect(pinned).not.toContain("best fits the topic");
  });

  it("explains actionLevel and suggestedTransition", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16" });
    expect(p).toContain('- actionLevel: "high" for fast or complex motion worth real video');
    expect(p).toContain("- suggestedTransition: how the cut into this scene should feel");
    expect(p).toContain("Do not describe the art style");
  });

  it("appends validation feedback on retry", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "16:9", feedback: "scene 2 narration has 30 words" });
    expect(p).toContain("rejected");
    expect(p).toContain("scene 2 narration has 30 words");
  });

  it("produces a JSON schema without $schema", () => {
    const s = scriptJsonSchema() as { $schema?: string; properties: { scenes: { maxItems: number } } };
    expect(s.$schema).toBeUndefined();
    expect(s.properties.scenes.maxItems).toBe(12);
  });

  it("requires the 2.2 fields in Gemini's answer", () => {
    const s = scriptJsonSchema() as {
      required: string[];
      properties: { scenes: { items: { required: string[] } } };
    };
    expect(s.required).toContain("stylePreset");
    expect(s.properties.scenes.items.required).toEqual(expect.arrayContaining(["actionLevel", "suggestedTransition"]));
  });
});

describe("elevenlabs", () => {
  const alignment = {
    characters: [..."Hi  yo"],
    character_start_times_seconds: [0, 0.1, 0.2, 0.25, 0.3, 0.4],
    character_end_times_seconds: [0.1, 0.2, 0.25, 0.3, 0.4, 0.5],
  };

  it("builds words from character alignment", () => {
    expect(wordsFromAlignment(alignment)).toEqual([
      { text: "Hi", start: 0, end: 0.2 },
      { text: "yo", start: 0.3, end: 0.5 },
    ]);
  });

  it("calls with-timestamps with continuity context and decodes the audio", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ audio_base64: Buffer.from("MP3").toString("base64"), alignment, normalized_alignment: null }),
        { status: 200 },
      );
    }) as typeof fetch;
    const tts = new ElevenLabsTts("key", "eleven_multilingual_v2", fakeFetch);
    const r = await tts.speak({ text: "Hi  yo", previousText: "Before.", voiceId: "voice/1" });
    expect(calls[0].url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1/with-timestamps?output_format=mp3_44100_128",
    );
    expect(calls[0].body).toEqual({ text: "Hi  yo", model_id: "eleven_multilingual_v2", previous_text: "Before." });
    expect(r.audio.toString()).toBe("MP3");
    expect(r.words).toHaveLength(2);
  });

  it("surfaces HTTP errors with their status", async () => {
    const fakeFetch = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    const err = await new ElevenLabsTts("k", "m", fakeFetch).speak({ text: "x", voiceId: "v" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect((err as Error).message).toBe("ElevenLabs TTS HTTP 401: bad key");
  });
});

describe("fal adapters", () => {
  type Status = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  function fakeFal(data: unknown, statuses: Status[] = ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]) {
    const submits: Array<{ id: string; input: Record<string, unknown>; abortSignal?: AbortSignal }> = [];
    const polls: string[] = [];
    const results: string[] = [];
    const uploads: Blob[] = [];
    let poll = 0;
    const fal = {
      queue: {
        submit: async (id: string, opts: { input: Record<string, unknown>; abortSignal?: AbortSignal }) => {
          submits.push({ id, input: opts.input, abortSignal: opts.abortSignal });
          return { status: "IN_QUEUE", request_id: "req-1" };
        },
        status: async (_id: string, opts: { requestId: string }) => {
          polls.push(opts.requestId);
          return { status: statuses[Math.min(poll++, statuses.length - 1)], request_id: opts.requestId };
        },
        result: async (_id: string, opts: { requestId: string }) => {
          results.push(opts.requestId);
          return { requestId: opts.requestId, data };
        },
      },
      storage: { upload: async (b: Blob) => (uploads.push(b), "https://fal.media/up.png") },
    } as unknown as FalLike;
    return { fal, submits, polls, results, uploads };
  }
  const fast = { pollMs: 0, sleep: async () => {} };

  it("submits a Flux image at an explicit size and waits for it through the queue", async () => {
    const { fal, submits, polls, results } = fakeFal({ images: [{ url: "https://fal.media/k.png" }], seed: 77 });
    const image = new FalImage(fal, "fal-ai/flux/dev", fast);
    const signal = new AbortController().signal;
    const id = await image.submit(await image.prepare({ prompt: "p", width: 1088, height: 1920 }), { signal });
    expect(id).toBe("req-1");
    expect(submits[0].abortSignal).toBe(signal);
    expect(submits[0].input).toMatchObject({ prompt: "p", image_size: { width: 1088, height: 1920 }, num_images: 1 });
    expect(submits[0].input).not.toHaveProperty("seed");
    expect(await image.wait(id, { timeoutMs: 1000 })).toEqual({ url: "https://fal.media/k.png", seed: 77 });
    expect(polls).toEqual(["req-1", "req-1", "req-1"]);
    expect(results).toEqual(["req-1"]);
    expect(submits).toHaveLength(1);
  });

  it("rejects NSFW-flagged or missing images as unusable (not retryable)", async () => {
    const nsfw = fakeFal({ images: [{ url: "https://fal.media/k.png" }], seed: 1, has_nsfw_concepts: [true] });
    const err = await new FalImage(nsfw.fal, "m", fast).wait("req-1", { timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnusableResultError);
    expect((err as Error).message).toMatch(/req-1 was flagged NSFW/);
    expect(isRetryable(err)).toBe(false);

    const empty = fakeFal({ images: [], seed: 1 });
    await expect(new FalImage(empty.fal, "m", fast).wait("req-1", { timeoutMs: 1000 })).rejects.toThrow(
      /completed without an image/,
    );
  });

  it("stops waiting at its deadline without resubmitting", async () => {
    const { fal, submits, polls } = fakeFal({}, ["IN_PROGRESS"]);
    let t = 0;
    const video = new FalVideo(fal, "kling", { pollMs: 1000, sleep: async (ms) => void (t += ms), now: () => t });
    const err = await video.wait("req-9", { timeoutMs: 5000 }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("fal request req-9 is still IN_PROGRESS after 5 s");
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(polls.length).toBe(6);
    expect(submits).toHaveLength(0);
  });

  it("uploads the chain image, requests the clip length as a string and returns the video URL", async () => {
    const { fal, submits, uploads } = fakeFal({ video: { url: "https://fal.media/c.mp4" } });
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    const img = join(dir, "last.png");
    await writeFile(img, "png-bytes");
    const video = new FalVideo(fal, "fal-ai/kling-video/v2.1/standard/image-to-video", fast);
    const prepared = await video.prepare({ imagePath: img, prompt: "move", durationSec: 10 });
    expect(uploads).toHaveLength(1); // the upload happens while preparing, before anything is bought
    expect(submits).toHaveLength(0);
    const signal = new AbortController().signal;
    const id = await video.submit(prepared, { signal });
    expect(uploads).toHaveLength(1); // submitting does not upload again
    expect(submits[0].abortSignal).toBe(signal);
    expect(submits[0].input).toMatchObject({ image_url: "https://fal.media/up.png", prompt: "move", duration: "10" });
    expect(await video.wait(id, { timeoutMs: 1000 })).toEqual({ url: "https://fal.media/c.mp4" });
  });

  it("rejects a completed video job without a video URL as unusable", async () => {
    const { fal } = fakeFal({ video: null });
    await expect(new FalVideo(fal, "m", fast).wait("req-1", { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      UnusableResultError,
    );
  });
});
