"use client";
import { useState } from "react";
import { amount, ApiFailure, errorText, sendJson } from "@/lib/api";
import { showsCredits } from "@/lib/credit";
import { ideasPriceUsd, type IdeasResult } from "@/lib/ideas";
import { IDEAS_LABELS } from "@/lib/labels";
import { Button, ErrorNote } from "./ui";

/** "Suggest a topic" (phase 13): asks for ideas for the form's niche and language and lets the user pick one. Picking fills the topic field and starts nothing. */
export function IdeaSuggestions({ request, onPick }: { request: { language: string; niche?: unknown; format?: string }; onPick: (topic: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IdeasResult | null>(null);
  // only a studio with accounts charges for a click, and shows the price in credits
  const accounts = showsCredits();
  const price = accounts ? ideasPriceUsd() : undefined;
  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const answer = await sendJson<IdeasResult>("/api/ideas", request);
      setResult(answer);
      if (answer.ideas.length === 0) setError(`${IDEAS_LABELS.none}${accounts ? ` ${IDEAS_LABELS.returned}` : ""}`);
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiFailure && err.code === "ideas_failed" ? `${IDEAS_LABELS.none}${accounts ? ` ${IDEAS_LABELS.returned}` : ""}` : errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3" data-testid="idea-suggestions">
      <Button type="button" data-testid="suggest-topic" disabled={busy} onClick={ask}>
        {IDEAS_LABELS.button}{price !== undefined ? ` · ${amount(price)}` : ""}
      </Button>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {result?.ideas.map((idea) => (
        <div key={idea.topic} className="space-y-1.5 rounded-[16px] bg-sheet p-3 text-[0.9rem]" data-testid="idea">
          <p className="font-bold">{idea.topic}</p>
          <p className="text-graphite">{IDEAS_LABELS.why}: {idea.why}</p>
          {idea.sources.length > 0 ? (
            <p className="flex flex-wrap gap-x-3 text-graphite">
              <span>{IDEAS_LABELS.sources}:</span>
              {idea.sources.map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="underline">{s.title}</a>
              ))}
            </p>
          ) : null}
          <Button type="button" onClick={() => onPick(idea.topic)}>{IDEAS_LABELS.use}</Button>
        </div>
      ))}
    </div>
  );
}
