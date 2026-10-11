import type { WordTiming } from "../manifest/schema.js";
import { HttpError } from "./retry.js";
import type { SpeakRequest, TtsProvider } from "./types.js";

/*
 * The hosted voice (phase 5 spec §11): every new run is spoken here while its key is set. It was the studio's
 * voice before phase 5 and was dropped for the studio's own; it is back because the owner's listening test of
 * the own voice failed in Turkish and in telling its voices apart (§11.1). A line's words and their times come
 * back with its sound, so captions need nothing else.
 */

/** Where the service is; a test's stand-in is reached through ELEVENLABS_API_BASE, as Stripe's is through STRIPE_API_BASE. */
const api = (): string => process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io";

/**
 * The models that are told a line's language. The others refuse one (they work it out from the text, which they
 * do well for a whole line of Turkish; a test of the own voice showed what a model that guesses can do to a word
 * like "her", so a model that takes the language is told it).
 */
const TAKES_LANGUAGE = new Set(["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_v3"]);

export type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

export function wordsFromAlignment(a: Alignment): WordTiming[] {
  const words: WordTiming[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (text) words.push({ text, start, end });
      text = "";
      return;
    }
    if (!text) start = a.character_start_times_seconds[i];
    text += ch;
    end = a.character_end_times_seconds[i];
  });
  if (text) words.push({ text, start, end });
  return words;
}

export class ElevenLabsTts implements TtsProvider {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    /** What a thousand characters cost: a line is billed by its characters, so that is what it is charged. */
    private readonly usdPer1kChars: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async speak(req: SpeakRequest): Promise<{ audio: Buffer; words: WordTiming[]; costUsd: number }> {
    const url = `${api()}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        text: req.text,
        model_id: this.model,
        previous_text: req.previousText,
        next_text: req.nextText,
        ...(req.language && TAKES_LANGUAGE.has(this.model) ? { language_code: req.language } : {}),
      }),
    });
    if (!res.ok) throw new HttpError(`ElevenLabs TTS HTTP ${res.status}: ${await res.text()}`, res.status);
    const body = (await res.json()) as {
      audio_base64: string;
      alignment: Alignment | null;
      normalized_alignment: Alignment | null;
    };
    const alignment = body.alignment ?? body.normalized_alignment;
    if (!alignment) throw new Error("ElevenLabs response contained no alignment");
    const costUsd = Math.round((req.text.length / 1000) * this.usdPer1kChars * 10_000) / 10_000;
    return { audio: Buffer.from(body.audio_base64, "base64"), words: wordsFromAlignment(alignment), costUsd };
  }

  async checkVoice(voiceId: string): Promise<void> {
    const res = await this.fetchImpl(`${api()}/v1/voices/${encodeURIComponent(voiceId)}`, {
      headers: { "xi-api-key": this.apiKey },
    });
    if (!res.ok) throw new Error(`ElevenLabs voice ${voiceId}: HTTP ${res.status} ${await res.text()}`);
  }
}
