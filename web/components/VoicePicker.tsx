"use client";
import { SPEECH_LANGUAGES, type SpeechLanguage, type VoiceId, VOICES } from "@src/voice/language";
import { useEffect, useRef, useState } from "react";
import { Segmented } from "./ui";

/**
 * The language a video is told in and the voice that tells it (phase 7 spec §13). Every voice speaks every
 * language on offer, so the voices are the same whichever is chosen; what changes is the sample, which is that
 * voice speaking that language. One sample plays at a time.
 */
export function VoicePicker({ language, voice, onLanguage, onVoice }: { language: SpeechLanguage; voice: VoiceId; onLanguage: (l: SpeechLanguage) => void; onVoice: (v: VoiceId) => void }) {
  const player = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<VoiceId | null>(null);
  const stop = () => {
    player.current?.pause();
    player.current = null;
    setPlaying(null);
  };
  // a sample is of one language: choosing another ends it, and so does leaving the page
  useEffect(() => stop, [language]);
  const listen = (id: VoiceId) => {
    if (playing === id) return stop();
    stop();
    const audio = new Audio(`/voices/${id}.${language}.mp3`);
    audio.addEventListener("ended", () => setPlaying((now) => (now === id ? null : now)));
    player.current = audio;
    setPlaying(id);
    void audio.play().catch(() => setPlaying(null));
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 text-[0.95rem]">
        <span className="font-bold">Language</span>
        <Segmented label="Language" value={language} onChange={onLanguage} options={(Object.keys(SPEECH_LANGUAGES) as SpeechLanguage[]).map((code) => ({ value: code, label: SPEECH_LANGUAGES[code] }))} />
        <span className="text-[0.85rem] text-graphite">The script is written in it, and the captions follow.</span>
      </div>
      <div role="radiogroup" aria-label="Voice" className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(VOICES) as VoiceId[]).map((id) => {
          const on = id === voice;
          return (
            <div key={id} className={`flex items-center gap-3 rounded-[18px] bg-sheet p-3 outline-offset-2 ${on ? "outline outline-[3px] outline-signal" : ""}`}>
              <button
                type="button"
                data-testid={`listen-${id}`}
                aria-label={playing === id ? `Stop the sample of ${VOICES[id].label}` : `Hear ${VOICES[id].label} in ${SPEECH_LANGUAGES[language]}`}
                onClick={() => listen(id)}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-signal text-[0.95rem] font-bold text-paper hover:bg-ink"
              >
                <span aria-hidden>{playing === id ? "❚❚" : "▶"}</span>
              </button>
              <button type="button" role="radio" aria-checked={on} data-testid={`voice-${id}`} onClick={() => onVoice(id)} className="flex-1 text-left">
                <span className="block font-bold"><span className={on ? "marked" : ""}>{VOICES[id].label}</span></span>
                <span className="block text-[0.85rem] text-graphite">{on ? "Tells this video" : "Choose this voice"}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
