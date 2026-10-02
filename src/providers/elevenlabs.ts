import type { WordTiming } from "../manifest/schema.js";
import type { SpeakRequest, TtsProvider } from "./types.js";

const API = "https://api.elevenlabs.io";

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
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async speak(req: SpeakRequest): Promise<{ audio: Buffer; words: WordTiming[] }> {
    const url = `${API}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        text: req.text,
        model_id: this.model,
        previous_text: req.previousText,
        next_text: req.nextText,
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      audio_base64: string;
      alignment: Alignment | null;
      normalized_alignment: Alignment | null;
    };
    const alignment = body.alignment ?? body.normalized_alignment;
    if (!alignment) throw new Error("ElevenLabs response contained no alignment");
    return { audio: Buffer.from(body.audio_base64, "base64"), words: wordsFromAlignment(alignment) };
  }

  async checkVoice(voiceId: string): Promise<void> {
    const res = await this.fetchImpl(`${API}/v1/voices/${encodeURIComponent(voiceId)}`, {
      headers: { "xi-api-key": this.apiKey },
    });
    if (!res.ok) throw new Error(`ElevenLabs voice ${voiceId}: HTTP ${res.status} ${await res.text()}`);
  }
}
