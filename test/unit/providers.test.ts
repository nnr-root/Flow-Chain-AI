import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ElevenLabsTts, wordsFromAlignment } from "../../src/providers/elevenlabs.js";
import { FalImage, type FalLike, FalVideo } from "../../src/providers/fal.js";
import { buildScriptPrompt, scriptJsonSchema } from "../../src/providers/gemini.js";

describe("gemini prompt and schema", () => {
  it("asks for the exact scene count and word cap", () => {
    const p = buildScriptPrompt({ topic: "octopus intelligence", sceneCount: 5, aspect: "9:16" });
    expect(p).toContain('"octopus intelligence"');
    expect(p).toContain("exactly 5 scenes");
    expect(p).toContain("at most 22 words");
    expect(p).toContain("vertical 9:16");
    expect(p).not.toContain("rejected");
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

  it("surfaces HTTP errors", async () => {
    const fakeFetch = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    await expect(new ElevenLabsTts("k", "m", fakeFetch).speak({ text: "x", voiceId: "v" })).rejects.toThrow(
      "ElevenLabs TTS HTTP 401: bad key",
    );
  });
});

describe("fal adapters", () => {
  function fakeFal() {
    const calls: Array<{ id: string; input: Record<string, unknown> }> = [];
    const uploads: Blob[] = [];
    const fal = {
      subscribe: async (id: string, opts: { input: Record<string, unknown> }) => {
        calls.push({ id, input: opts.input });
        const data = id.includes("flux")
          ? { images: [{ url: "https://fal.media/k.png" }], seed: 77 }
          : { video: { url: "https://fal.media/c.mp4" } };
        return { requestId: "r1", data };
      },
      storage: { upload: async (b: Blob) => (uploads.push(b), "https://fal.media/up.png") },
    } as unknown as FalLike;
    return { fal, calls, uploads };
  }

  it("generates a Flux image at an explicit size", async () => {
    const { fal, calls } = fakeFal();
    const r = await new FalImage(fal, "fal-ai/flux/dev").generate({ prompt: "p", width: 1088, height: 1920 });
    expect(r).toEqual({ url: "https://fal.media/k.png", seed: 77 });
    expect(calls[0].input).toMatchObject({ prompt: "p", image_size: { width: 1088, height: 1920 }, num_images: 1 });
    expect(calls[0].input).not.toHaveProperty("seed");
  });

  it("uploads the chain image and requests the clip length as a string", async () => {
    const { fal, calls, uploads } = fakeFal();
    const dir = await mkdtemp(join(tmpdir(), "fc-"));
    const img = join(dir, "last.png");
    await writeFile(img, "png-bytes");
    const r = await new FalVideo(fal, "fal-ai/kling-video/v2.1/standard/image-to-video").imageToVideo({
      imagePath: img,
      prompt: "move",
      durationSec: 10,
    });
    expect(r).toEqual({ url: "https://fal.media/c.mp4" });
    expect(uploads).toHaveLength(1);
    expect(calls[0].input).toMatchObject({ image_url: "https://fal.media/up.png", prompt: "move", duration: "10" });
  });
});
