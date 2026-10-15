import { MAX_SCENES } from "../../src/manifest/schema.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ElevenLabsTts, wordsFromAlignment } from "../../src/providers/elevenlabs.js";
import { hostedCatalogue, hostedLanguages, hostedRoles, hostedVoice } from "../../src/voice/hosted.js";
import { HttpError, isRetryable, NonRetryableError, UnusableResultError } from "../../src/providers/retry.js";
import { buildScriptPrompt, scriptJsonSchema, mostEntries } from "../../src/providers/gemini.js";
import { PRESETS } from "../../src/presets.js";

describe("gemini prompt and schema", () => {
  it("asks for the exact scene count and word cap", () => {
    const p = buildScriptPrompt({ topic: "octopus intelligence", sceneCount: 5, aspect: "9:16" });
    expect(p).toContain('"octopus intelligence"');
    expect(p).toContain("exactly 5 scenes");
    expect(p).toContain("at most 16 words (ideally 12-15)");
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

  it("pins the character bible when the run has one", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16", characters: "Nova: silver bob" });
    expect(p).toContain('- styleBible.characters: use exactly: "Nova: silver bob". Refer to these characters consistently');
    expect(buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16" })).toContain(
      "- styleBible.characters: a precise, reusable description",
    );
  });

  it("asks for a short teasing hook", () => {
    expect(buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16" })).toContain(
      "- hook: 2-6 punchy words shown as a big title over the first 3 seconds",
    );
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
    // the list is as long as this one answer may be, never as long as a run can be: the service refuses hundreds
    expect(s.properties.scenes.maxItems).toBe(12);
    expect(mostEntries({ topic: "t", sceneCount: 4, aspect: "9:16" })).toBe(12);
    const timing = { targetSec: 600, sceneSec: { min: 2, max: 2 } };
    expect(mostEntries({ topic: "t", sceneCount: 300, aspect: "9:16", timing: { targetSec: 30, sceneSec: { min: 3, max: 5 } } })).toBe(12);
    expect(mostEntries({ topic: "t", sceneCount: 300, aspect: "9:16", timing, ask: { kind: "outline", partSec: Array(10).fill(60) } })).toBe(10);
    expect(mostEntries({ topic: "t", sceneCount: 300, aspect: "9:16", timing, ask: { kind: "part", index: 0, partSec: Array(10).fill(60), outline: {} as never, previous: [] } })).toBe(36);
    // a list longer than the service takes a limit for says none (the answer's count is checked when it is back)
    expect((scriptJsonSchema("part", 36) as { properties: { scenes: { maxItems?: number } } }).properties.scenes.maxItems).toBeUndefined();
    expect((scriptJsonSchema("script", 12) as { properties: { scenes: { maxItems?: number } } }).properties.scenes.maxItems).toBe(12);
    expect((scriptJsonSchema("outline", 10) as { properties: { parts: { maxItems?: number } } }).properties.parts.maxItems).toBe(10);
    expect(MAX_SCENES).toBeGreaterThan(36 * 9);
    // a long video's two kinds of answer have schemas of their own
    expect(Object.keys((scriptJsonSchema("outline") as { properties: object }).properties)).toEqual(["title", "stylePreset", "styleBible", "hook", "parts", "hashtags"]);
    // and the hashtags are the last thing of the whole one too, written once the video is (phase 7 spec §18)
    expect(Object.keys((scriptJsonSchema("script") as { properties: object }).properties).at(-1)).toBe("hashtags");
    expect(Object.keys((scriptJsonSchema("part") as { properties: object }).properties)).toEqual(["scenes"]);
  });

  it("requires the 2.2 fields in Gemini's answer", () => {
    const s = scriptJsonSchema() as {
      required: string[];
      properties: { scenes: { items: { required: string[] } } };
    };
    expect(s.required).toContain("stylePreset");
    expect(s.properties.scenes.items.required).toEqual(expect.arrayContaining(["actionLevel", "suggestedTransition", "showsCharacter"]));
  });
});

describe("the hosted voice (phase 5 spec §11)", () => {
  const alignment = {
    characters: [..."Hi  yo"],
    character_start_times_seconds: [0, 0.1, 0.2, 0.25, 0.3, 0.4],
    character_end_times_seconds: [0.1, 0.2, 0.25, 0.3, 0.4, 0.5],
  };
  const answering = (calls: Array<{ url: string; body: Record<string, unknown> }>) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ audio_base64: Buffer.from("MP3").toString("base64"), alignment, normalized_alignment: null }), { status: 200 });
    }) as typeof fetch;

  it("builds words from character alignment", () => {
    expect(wordsFromAlignment(alignment)).toEqual([
      { text: "Hi", start: 0, end: 0.2 },
      { text: "yo", start: 0.3, end: 0.5 },
    ]);
  });

  it("calls with-timestamps with continuity context, decodes the audio and charges the line by its characters", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const tts = new ElevenLabsTts("key", "eleven_multilingual_v2", 0.3, answering(calls));
    const r = await tts.speak({ text: "Hi  yo", previousText: "Before.", voiceId: "voice/1", language: "tr" });
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%2F1/with-timestamps?output_format=mp3_44100_128");
    // this model works the language out from the text and refuses to be told one
    expect(calls[0].body).toEqual({ text: "Hi  yo", model_id: "eleven_multilingual_v2", previous_text: "Before." });
    expect(r.audio.toString()).toBe("MP3");
    expect(r.words).toHaveLength(2);
    expect(r.costUsd).toBe(Math.round(0.006 * 0.3 * 10_000) / 10_000);
  });

  it("tells a model that takes one the line's language", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    await new ElevenLabsTts("key", "eleven_flash_v2_5", 0.3, answering(calls)).speak({ text: "Her gün", voiceId: "v", language: "tr" });
    expect(calls[0].body).toMatchObject({ model_id: "eleven_flash_v2_5", language_code: "tr" });
  });

  it("surfaces HTTP errors with their status", async () => {
    const fakeFetch = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    const err = await new ElevenLabsTts("k", "m", 0.3, fakeFetch).speak({ text: "x", voiceId: "v" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect((err as Error).message).toBe("ElevenLabs TTS HTTP 401: bad key");
  });
});

describe("the catalogue of hosted voices", () => {
  const write = async (content: unknown) => {
    const dir = await mkdtemp(join(tmpdir(), "hosted-"));
    await writeFile(join(dir, "elevenlabs.json"), JSON.stringify(content));
    return dir;
  };

  it("gives a voice the one chosen for the language, else its English one, and nothing for what it does not list", async () => {
    const dir = await write({ voices: { storyteller: { en: { id: "StoryEn0001", name: "A" }, tr: { id: "StoryTr0001", name: "B" } }, calm: { tr: { id: "CalmTr00001", name: "C" } } } });
    expect(hostedVoice("storyteller", "tr", dir)).toBe("StoryTr0001");
    expect(hostedVoice("storyteller", "pt", dir)).toBe("StoryEn0001");
    expect(hostedVoice("storyteller", undefined, dir)).toBe("StoryEn0001");
    expect(hostedVoice("voice-1", "en", dir)).toBeNull();
    // a voice is offered once it has an English voice, and is native where it has one of that language
    expect(hostedRoles(dir)).toEqual(["storyteller"]);
    expect(hostedLanguages("storyteller", dir)).toEqual(["en", "tr"]);
    // none chosen at all: nothing is hosted
    expect(hostedRoles(await mkdtemp(join(tmpdir(), "hosted-")))).toEqual([]);
  });

  it("refuses a file the owner got wrong rather than sending a voice the service does not know", async () => {
    await expect(write({ voices: { storyteller: { en: { id: "../x", name: "A" } } } }).then((d) => hostedCatalogue(d))).rejects.toThrow();
    await expect(write({ voices: { storyteller: { english: { id: "StoryEn0001", name: "A" } } } }).then((d) => hostedCatalogue(d))).rejects.toThrow();
    await expect(write({ voices: {}, extra: 1 }).then((d) => hostedCatalogue(d))).rejects.toThrow();
  });
});
