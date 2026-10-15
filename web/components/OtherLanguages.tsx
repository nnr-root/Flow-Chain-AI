"use client";
import { SPEECH_LANGUAGES, type SpeechLanguage, type VoiceId, VOICES } from "@src/voice/language";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { amount, errorText, sendJson } from "@/lib/api";
import { CreditNote, tooLittle, useBalance } from "@/lib/balance";
import { Button, ErrorNote } from "./ui";

export type VersionChoices = {
  languages: SpeechLanguage[];
  voices: Partial<Record<SpeechLanguage, VoiceId[]>>;
  names: Partial<Record<SpeechLanguage, Partial<Record<VoiceId, { label?: string }>>>>;
};

type Price = { totalUsd: number; capUsd: number };

/**
 * A finished video made again in another language (phase 8 spec §4): the same pictures and clips, a new narration,
 * voice and captions, as a new video of its own. Priced before it is asked for; what it holds is what is shown.
 */
export function OtherLanguages({ runId, from, voice, choices }: { runId: string; from?: string; voice: string; choices: VersionChoices }) {
  const router = useRouter();
  const languages = choices.languages.filter((l) => l !== from && (choices.voices[l]?.length ?? 0) > 0);
  const [language, setLanguage] = useState<SpeechLanguage | "">("");
  const [voiceId, setVoiceId] = useState<VoiceId | "">("");
  const [price, setPrice] = useState<Price | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const balance = useBalance();
  const voices = language ? (choices.voices[language] ?? []) : [];

  // the run's own voice where the new language has it, else that language's first
  useEffect(() => {
    if (!language) return;
    setVoiceId(voices.includes(voice as VoiceId) ? (voice as VoiceId) : (voices[0] ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  useEffect(() => {
    setPrice(null);
    setError("");
    if (!language || !voiceId) return;
    let live = true;
    sendJson<Price>(`/api/runs/${runId}/versions/price`, { language, voiceId }).then(
      (p) => live && setPrice(p),
      (err) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [runId, language, voiceId]);

  async function make() {
    if (!language || !voiceId || !price) return;
    setBusy(true);
    setError("");
    try {
      const made = await sendJson<{ runId: string }>(`/api/runs/${runId}/versions`, { language, voiceId, approvedUsd: price.capUsd });
      router.push(`/runs/${made.runId}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (languages.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="other-languages">
      <p className="text-[0.95rem] text-graphite">The same pictures and clips, with the narration, the voice, the captions and the hashtags in another language: a new video of its own.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <select data-testid="version-language" aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value as SpeechLanguage)}>
          <option value="">Choose a language</option>
          {languages.map((l) => <option key={l} value={l}>{SPEECH_LANGUAGES[l]}</option>)}
        </select>
        {language && (
          <select data-testid="version-voice" aria-label="Voice" value={voiceId} onChange={(e) => setVoiceId(e.target.value as VoiceId)}>
            {voices.map((v) => <option key={v} value={v}>{choices.names[language]?.[v]?.label ?? VOICES[v]?.label ?? v}</option>)}
          </select>
        )}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {language && (
        <>
          <CreditNote balance={balance} needUsd={price?.capUsd} />
          <Button tone="primary" data-testid="make-version" onClick={make} disabled={busy || !price || tooLittle(balance, price.capUsd)}>
            {busy ? "Starting…" : price ? `Make it in ${SPEECH_LANGUAGES[language]}, up to ${amount(price.capUsd)}` : "Pricing…"}
          </Button>
        </>
      )}
    </div>
  );
}
