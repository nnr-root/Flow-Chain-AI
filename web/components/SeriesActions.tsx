"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorText, sendJson, amount } from "@/lib/api";
import { CreditNote, tooLittle, useBalance } from "@/lib/balance";
import { Button, ErrorNote } from "./ui";

/**
 * What can be done with a series: have its next video started, or remove it. Starting one is the ordinary paid
 * draft (the script, held from credit), so the button says what it holds (`holdUsd`, which follows from how long
 * the series' videos are) and is shut when credit does not cover it.
 */
export function SeriesActions({ id, name, episodes, holdUsd }: { id: string; name: string; episodes: number; holdUsd: number }) {
  const router = useRouter();
  const balance = useBalance();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sure, setSure] = useState(false);

  const next = () => {
    setBusy("next");
    setError("");
    sendJson<{ runId: string }>(`/api/series/${id}/episodes`, {}).then(
      ({ runId }) => router.push(`/runs/${runId}`),
      (err: unknown) => {
        setError(errorText(err));
        setBusy("");
      },
    );
  };
  const remove = () => {
    setBusy("remove");
    setError("");
    sendJson(`/api/series/${id}`, {}, "DELETE").then(
      () => {
        router.push("/series");
        router.refresh();
      },
      (err: unknown) => {
        setError(errorText(err));
        setBusy("");
      },
    );
  };

  return (
    <div className="space-y-4">
      <ErrorNote>{error}</ErrorNote>
      <div className="flex flex-wrap items-center gap-3">
        <Button tone="primary" data-testid="next-episode" onClick={next} disabled={!!busy || tooLittle(balance, holdUsd)}>
          {busy === "next" ? "Writing the script…" : `Make ${episodes === 0 ? "the first video" : "the next video"}, up to ${amount(holdUsd)}`}
        </Button>
        <span className="text-[0.85rem] text-graphite">Buys only the script. You see the draft and the price of the rest before anything else is made.</span>
      </div>
      <CreditNote balance={balance} needUsd={holdUsd} />
      {sure ? (
        <div role="dialog" aria-label="Confirm removing the series" className="flex flex-wrap items-center gap-3 rounded-[18px] bg-wash px-4 py-3 text-[0.95rem]">
          <span className="flex-1">Remove “{name}”? Its videos stay in your list; they are only no longer in a series.</span>
          <Button tone="danger" data-testid="remove-series-sure" onClick={remove} disabled={!!busy}>{busy === "remove" ? "Removing…" : "Remove"}</Button>
          <Button onClick={() => setSure(false)} disabled={!!busy}>Keep it</Button>
        </div>
      ) : (
        <button type="button" data-testid="remove-series" onClick={() => setSure(true)} className="text-[0.85rem] text-graphite underline underline-offset-4 hover:text-ink">Remove this series</button>
      )}
    </div>
  );
}
