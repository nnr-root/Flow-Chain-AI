"use client";
import { SPEECH_LANGUAGES, type SpeechLanguage, type VoiceId, VOICES } from "@src/voice/language";
import { useEffect, useRef, useState } from "react";
import listed from "@/content/voice-samples.json";

/** Whether there is a sample of that voice in that language to hear (`npm run make:voices` makes them). */
const hasSample = (voice: VoiceId, language: SpeechLanguage): boolean => Object.hasOwn((listed.samples as Record<string, Record<string, unknown>>)[voice] ?? {}, language);

/**
 * The language a video is told in and the voice that tells it (phase 7 spec §13, §14). Every voice speaks every
 * language on offer, so the voices are the same whichever is chosen; what changes is the sample, which is that
 * voice speaking that language. One sample plays at a time. A voice with no sample in a language yet can still
 * be chosen: there is only nothing to hear beforehand.
 */
export function VoicePicker({ voices: native, names = {}, language, voice, onLanguage, onVoice }: { voices: Partial<Record<SpeechLanguage, VoiceId[]>>; names?: Partial<Record<SpeechLanguage, Partial<Record<VoiceId, { label?: string; about?: string }>>>>; language: SpeechLanguage; voice: VoiceId; onLanguage: (l: SpeechLanguage) => void; onVoice: (v: VoiceId) => void }) {
  // A voice is shown by its name where it has one in this language (Frederick, Adam…), and by what it is for
  // below it; the studio's own voices are shown by what they are (phase 5 spec §11.5).
  const title = (id: VoiceId) => names[language]?.[id]?.label ?? VOICES[id].label;
  // the voices made in this language; where none is yet, the narrators, said not to be native
  const voices = native[language]?.length ? native[language]! : (["narrator-m", "narrator-f"] as VoiceId[]);
  const notNative = !native[language]?.length;
  // a voice chosen in one language that has none in another is swapped for the first that has one
  useEffect(() => {
    if (!voices.includes(voice)) onVoice(voices[0]);
  }, [voices, voice, onVoice]);
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
        <label className="flex items-center gap-3">
          <span className="font-bold">Language</span>
          {/* (twenty of them: a list to choose from, each by its own name) */}
          <select data-testid="language" value={language} onChange={(e) => onLanguage(e.target.value as SpeechLanguage)} className="!w-auto min-w-[12rem]">
            {(Object.keys(SPEECH_LANGUAGES) as SpeechLanguage[]).map((code) => <option key={code} value={code}>{SPEECH_LANGUAGES[code]}</option>)}
          </select>
        </label>
        <span className="text-[0.85rem] text-graphite">The script is written in it, the voice speaks it, and the captions follow.</span>
      </div>
      {notNative && <p className="text-[0.85rem] text-warn" data-testid="voices-not-native">No voice has been made in this language yet: the narrators speak it from their English voice, with its accent.</p>}
      <div role="radiogroup" aria-label="Voice" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {voices.map((id) => {
          const on = id === voice;
          return (
            <div key={id} className={`flex items-start gap-3 rounded-[18px] bg-sheet p-3 outline-offset-2 ${on ? "outline outline-[3px] outline-signal" : ""}`}>
              <button
                type="button"
                disabled={!hasSample(id, language)}
                title={hasSample(id, language) ? undefined : "No sample in this language yet"}
                data-testid={`listen-${id}`}
                aria-label={playing === id ? `Stop the sample of ${title(id)}` : `Hear ${title(id)} in ${SPEECH_LANGUAGES[language]}`}
                onClick={() => listen(id)}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-signal text-[0.95rem] font-bold text-paper hover:bg-ink disabled:bg-wash disabled:text-graphite"
              >
                <span aria-hidden>{playing === id ? "❚❚" : "▶"}</span>
              </button>
              <button type="button" role="radio" aria-checked={on} data-testid={`voice-${id}`} onClick={() => onVoice(id)} className="flex-1 text-left">
                <span className="block font-bold"><span className={on ? "marked" : ""}>{title(id)}</span></span>
                {names[language]?.[id]?.about && <span className="block text-[0.82rem] leading-snug" data-testid={`about-${id}`}>{names[language]![id]!.about}</span>}
                <span className="block text-[0.82rem] leading-snug text-graphite">{VOICES[id].suits}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
