import { execa } from "execa";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pitchFits, TOO_ALIKE, voiceDistance, voiceFeatures } from "../../src/voice/features.js";
import { designedClip } from "../../src/voice/library.js";
import { OWN_VOICE_IDS, VOICE_DESIGNS, VOICES } from "../../src/voice/language.js";

/* Telling voices apart (phase 7 spec §16), on made sounds whose pitch and colour are known. */
const tone = (hz: number, harmonics: number[], seconds = 1): Float32Array =>
  Float32Array.from({ length: 16000 * seconds }, (_, t) => harmonics.reduce((s, a, k) => s + a * Math.sin((2 * Math.PI * hz * (k + 1) * t) / 16000), 0) * 0.3);

describe("measuring a voice", () => {
  it("finds the pitch it is spoken at, and the sex it fits", () => {
    expect(voiceFeatures(tone(110, [1, 0.5, 0.3])).f0).toBeCloseTo(110, -1);
    expect(voiceFeatures(tone(220, [1, 0.5, 0.3])).f0).toBeCloseTo(220, -1);
    expect(pitchFits(voiceFeatures(tone(110, [1, 0.5])), "m")).toBe(true);
    expect(pitchFits(voiceFeatures(tone(240, [1, 0.5])), "f")).toBe(true);
    expect(pitchFits(voiceFeatures(tone(240, [1, 0.5])), "m")).toBe(false);
    // silence says nothing
    expect(voiceFeatures(new Float32Array(16000)).f0).toBe(0);
  });

  it("holds one voice near itself and two different ones apart", () => {
    const a = voiceFeatures(tone(120, [1, 0.6, 0.4, 0.2]));
    const again = voiceFeatures(tone(122, [1, 0.6, 0.4, 0.2]));
    const higher = voiceFeatures(tone(240, [1, 0.6, 0.4, 0.2]));
    const brighter = voiceFeatures(tone(120, [0.2, 0.4, 1, 1, 0.8, 0.6]));
    expect(voiceDistance(a, again)).toBeLessThan(TOO_ALIKE);
    expect(voiceDistance(a, higher)).toBeGreaterThan(TOO_ALIKE);
    expect(voiceDistance(a, brighter)).toBeGreaterThan(voiceDistance(a, again));
  });
});

describe("the voices on the list", () => {
  it("are each described by more than a mood: a sex, an age or pitch, and the grain of the voice", () => {
    expect(Object.keys(VOICE_DESIGNS).sort()).toEqual([...OWN_VOICE_IDS].sort());
    const descriptions = Object.values(VOICE_DESIGNS).map((d) => d.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const { sex, description } of Object.values(VOICE_DESIGNS)) {
      expect(description).not.toMatch(/[()]/);
      expect(description.toLowerCase()).toMatch(sex === "m" ? /\b(man|boy)\b/ : /\b(woman|girl)\b/);
    }
    // as many women as men
    const sexes = Object.values(VOICE_DESIGNS).map((d) => d.sex);
    expect(sexes.filter((s) => s === "m").length).toBe(sexes.filter((s) => s === "f").length);
  });

  it("speak a language from a clip made in it where there is one, and never from another language's when there is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voices-"));
    await writeFile(join(dir, "voices.json"), JSON.stringify({ calm: { en: "Hello.", tr: "Merhaba." }, "narrator-m": { es: "Hola." } }));
    for (const f of ["calm.en", "calm.tr", "narrator-m.es"]) await writeFile(join(dir, `${f}.flac`), Buffer.from(`fLaC-${f}`));
    expect(designedClip("calm", "tr", dir)?.text).toBe("Merhaba.");
    // a voice made here with no clip in a language falls back to its English one
    expect(designedClip("calm", "de", dir)?.text).toBe("Hello.");
    // the worker's own voice: its Spanish clip here, and for its English or Turkish, the worker's own
    expect(designedClip("narrator-m", "es", dir)?.text).toBe("Hola.");
    expect(designedClip("narrator-m", "tr", dir)).toBeNull();
    expect(designedClip("narrator-m", "en", dir)).toBeNull();
    expect(designedClip("someone", "en", dir)).toBeNull();
  });
});

describe("a clip as it is measured", () => {
  it("is read from a sound file at 16 kHz", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voice-"));
    const file = join(dir, "x.flac");
    await execa("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=150:sample_rate=48000", "-t", "1", "-ac", "1", file]);
    const { stdout } = await execa("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { encoding: "buffer", stripFinalNewline: false });
    const buf = Buffer.from(stdout);
    const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    expect(samples.length).toBeGreaterThan(15000);
    expect(voiceFeatures(samples).f0).toBeCloseTo(150, -1);
  });
});
