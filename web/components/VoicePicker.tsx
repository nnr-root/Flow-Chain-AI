"use client";
import { SPEECH_LANGUAGES, LANGUAGE_IN_ENGLISH, type SpeechLanguage, type VoiceId, VOICES, WELL_KNOWN_VOICE_IDS } from "@src/voice/language";
import { useEffect, useMemo, useRef, useState } from "react";
import listed from "@/content/voice-samples.json";

/** Whether there is a sample of that voice in that language to hear (`npm run make:voices` makes them). */
const hasSample = (voice: VoiceId, language: SpeechLanguage): boolean => Object.hasOwn((listed.samples as Record<string, Record<string, unknown>>)[voice] ?? {}, language);

type Names = Partial<Record<SpeechLanguage, Partial<Record<VoiceId, { label?: string; about?: string }>>>>;
type Sex = "all" | "female" | "male";
const WELL_KNOWN = new Set<string>(WELL_KNOWN_VOICE_IDS);

/** A voice's initial on a muted colour of its own: a face to tell the voices apart by at a glance. */
function Initial({ name, size, className = "grid" }: { name: string; size: "s" | "l"; className?: string }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  return (
    <span
      aria-hidden
      className={`${className} shrink-0 place-items-center rounded-full font-extrabold text-ink ${size === "l" ? "h-14 w-14 text-[1.35rem]" : "h-9 w-9 text-[0.95rem]"}`}
      style={{ background: `hsl(${hash} 28% 26%)` }}
    >
      {[...name][0]?.toLocaleUpperCase()}
    </span>
  );
}

/** Play or stop: white on black until it plays, then in the accent (the thing that is on). */
function Listen({ playing, disabled, label, onClick, testId, size }: { playing: boolean; disabled: boolean; label: string; onClick: () => void; testId: string; size: "s" | "l" }) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? "No sample in this language yet" : undefined}
      data-testid={testId}
      aria-label={label}
      onClick={onClick}
      className={`grid shrink-0 place-items-center rounded-full border text-[0.8rem] transition-colors disabled:cursor-not-allowed disabled:border-hairline disabled:text-graphite/50 ${size === "l" ? "h-12 w-12" : "h-9 w-9"} ${playing ? "border-signal bg-signal text-paper" : "border-hairline text-ink hover:border-ink"}`}
    >
      <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
    </button>
  );
}

/** "Male, British, middle aged" as small labels. */
const Tags = ({ about }: { about?: string }) =>
  about ? (
    <span className="flex flex-wrap gap-1">
      {about.split(", ").map((t) => t[0].toLocaleUpperCase() + t.slice(1)).map((t) => <span key={t} className="rounded-full bg-wash px-2 py-[0.1rem] text-[0.72rem] leading-snug text-graphite">{t}</span>)}
    </span>
  ) : null;

/**
 * The language a video is told in and the voice that tells it (phase 7 spec §13, §17; phase 5 spec §11.5). The
 * voice chosen is shown on top with its sample; underneath, every voice native to the language, to filter by sex,
 * look for by name or kind of video, and hear one at a time. The studio's voices, each for a kind of video, come
 * first; the hosted service's best-known ones are a group of their own. A language no voice is native to yet is
 * offered the narrators, and says they are not.
 */
export function VoicePicker({ voices: native, names = {}, languages = Object.keys(SPEECH_LANGUAGES) as SpeechLanguage[], language, voice, onLanguage, onVoice }: { voices: Partial<Record<SpeechLanguage, VoiceId[]>>; names?: Names; languages?: SpeechLanguage[]; language: SpeechLanguage; voice: VoiceId; onLanguage: (l: SpeechLanguage) => void; onVoice: (v: VoiceId) => void }) {
  // the voices made in this language; where none is yet, the narrators, said not to be native
  const voices = native[language]?.length ? native[language]! : (["narrator-m", "narrator-f"] as VoiceId[]);
  const notNative = !native[language]?.length;
  // a voice chosen in one language that has none in another is swapped for the first that has one
  useEffect(() => {
    if (!voices.includes(voice)) onVoice(voices[0]);
  }, [voices, voice, onVoice]);

  // A voice is shown by its name where it has one in this language (Frederick, Adam…), and by what it is for
  // below it; the studio's own voices are shown by what they are.
  const title = (id: VoiceId) => names[language]?.[id]?.label ?? VOICES[id].label;
  const about = (id: VoiceId) => names[language]?.[id]?.about;
  const sexOf = (id: VoiceId): Sex | undefined => {
    const first = about(id)?.split(", ")[0]?.toLowerCase();
    return first === "female" || first === "male" ? first : undefined;
  };

  const [sex, setSex] = useState<Sex>("all");
  const [query, setQuery] = useState("");
  // (a filter is of one language's voices: a new language starts with all of them)
  useEffect(() => {
    setSex("all");
    setQuery("");
  }, [language]);
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return voices.filter((id) => (sex === "all" || sexOf(id) === sex) && (!q || `${title(id)} ${about(id) ?? ""} ${VOICES[id].suits}`.toLocaleLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices, sex, query, language, names]);
  const groups = [
    { name: "For a kind of video", ids: shown.filter((id) => !WELL_KNOWN.has(id)) },
    { name: "Well-known voices", ids: shown.filter((id) => WELL_KNOWN.has(id)) },
  ].filter((g) => g.ids.length > 0);
  const filterable = voices.some((id) => sexOf(id));
  const count = (s: Sex) => voices.filter((id) => s === "all" || sexOf(id) === s).length;

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
  const listenLabel = (id: VoiceId) => (playing === id ? `Stop the sample of ${title(id)}` : `Hear ${title(id)} in ${SPEECH_LANGUAGES[language]}`);
  const chosen = voices.includes(voice) ? voice : voices[0];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <label className="block min-w-[15rem]">
          <span className="mb-1.5 block text-[0.85rem] font-bold">Language</span>
          {/* (thirty-one of them with the hosted voice: a list to choose from, each by its own name) */}
          <select data-testid="language" value={language} onChange={(e) => onLanguage(e.target.value as SpeechLanguage)} className="!w-full">
            {languages.map((code) => (
              <option key={code} value={code}>
                {SPEECH_LANGUAGES[code]}{SPEECH_LANGUAGES[code] !== LANGUAGE_IN_ENGLISH[code] ? ` · ${LANGUAGE_IN_ENGLISH[code].replace(/ \(.*\)$/, "")}` : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="max-w-[26rem] pb-2 text-[0.85rem] text-graphite">The script is written in it, the voice speaks it, and the captions follow.</p>
      </div>

      {/* the voice that will tell the video */}
      <div data-testid="voice-chosen" className="flex items-center gap-4 rounded-[22px] bg-sheet p-4">
        <Initial name={title(chosen)} size="l" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[0.8rem] font-bold text-graphite">Voice</p>
          <p className="text-[1.25rem] font-extrabold leading-tight">{title(chosen)}</p>
          <Tags about={about(chosen)} />
          <p className="text-[0.85rem] leading-snug text-graphite">{VOICES[chosen].suits}</p>
        </div>
        <Listen playing={playing === chosen} disabled={!hasSample(chosen, language)} label={listenLabel(chosen)} onClick={() => listen(chosen)} testId="listen-chosen" size="l" />
      </div>

      {notNative && <p className="text-[0.85rem] text-warn" data-testid="voices-not-native">No voice has been made in this language yet: the narrators speak it from their English voice, with its accent.</p>}

      <div className="rounded-[22px] bg-sheet">
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-3">
          {filterable && (["all", "female", "male"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={sex === s}
              data-testid={`voices-${s}`}
              onClick={() => setSex(s)}
              className={`rounded-full px-3.5 py-1.5 text-[0.85rem] font-bold ${sex === s ? "bg-signal text-paper" : "bg-wash text-ink hover:bg-hairline"}`}
            >
              {s === "all" ? "All" : s === "female" ? "Women" : "Men"} <span className={sex === s ? "" : "text-graphite"}>{count(s)}</span>
            </button>
          ))}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a voice by name or kind of video"
            aria-label="Find a voice"
            data-testid="voices-search"
            className="!w-auto min-w-[12rem] flex-1 !rounded-full !py-1.5 text-[0.9rem]"
          />
        </div>
        <div role="radiogroup" aria-label="Voice" className="max-h-[27rem] overflow-y-auto overscroll-contain [scrollbar-width:thin]">
          {groups.length === 0 && <p className="p-4 text-[0.9rem] text-graphite">No voice matches. Clear the search to see them all.</p>}
          {groups.map((g) => (
            <div key={g.name}>
              {groups.length > 1 || WELL_KNOWN.has(g.ids[0]) ? <p className="sticky top-0 z-10 bg-sheet px-4 pb-1 pt-3 text-[0.8rem] font-bold text-graphite">{g.name}</p> : null}
              {g.ids.map((id) => {
                const on = id === voice;
                return (
                  <div key={id} className={`flex items-center gap-3 px-3 py-2.5 sm:px-4 ${on ? "bg-wash" : "hover:bg-wash/60"}`}>
                    <Listen playing={playing === id} disabled={!hasSample(id, language)} label={listenLabel(id)} onClick={() => listen(id)} testId={`listen-${id}`} size="s" />
                    <button type="button" role="radio" aria-checked={on} data-testid={`voice-${id}`} onClick={() => onVoice(id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <Initial name={title(id)} size="s" className="hidden sm:grid" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-bold"><span className={on ? "marked" : ""}>{title(id)}</span></span>
                          {about(id) && <span className="text-[0.78rem] text-graphite" data-testid={`about-${id}`}>{about(id)}</span>}
                        </span>
                        <span className="block truncate text-[0.82rem] leading-snug text-graphite">{VOICES[id].suits}</span>
                      </span>
                      <span aria-hidden className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${on ? "border-signal bg-signal text-[0.7rem] font-black text-paper" : "border-hairline"}`}>{on ? "✓" : ""}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
