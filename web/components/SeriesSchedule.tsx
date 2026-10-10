"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorText, sendJson, amount } from "@/lib/api";
import { type Cadence, CADENCES, PAUSED, type SeriesView } from "@/lib/series";
import { Button, ErrorNote, Field, Panel } from "./ui";

const day = (iso: string): string => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * A series' schedule (phase 6 spec §15). A series that makes videos by itself spends without a click, so setting
 * a schedule here is its owner's approval for that. There is no amount to set: each video is held from the
 * owner's credit as any video is, and the series stops, and says why, when the credit does not cover the next.
 */
export function SeriesSchedule({ series }: { series: SeriesView }) {
  const router = useRouter();
  const [cadence, setCadence] = useState<Cadence>(series.cadence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scheduled = series.cadence !== "manual";
  const changed = cadence !== series.cadence;

  const send = (body: unknown) => {
    setBusy(true);
    setError("");
    sendJson(`/api/series/${series.id}`, body, "PATCH").then(
      () => {
        setBusy(false);
        router.refresh();
      },
      (err: unknown) => {
        setError(errorText(err));
        setBusy(false);
      },
    );
  };
  const save = () => send({ schedule: { cadence } });

  return (
    <Panel title="By itself" aside={scheduled ? <span className="note text-[0.9rem]" data-testid="series-status">{series.active ? "Running" : "Stopped"}</span> : undefined}>
      <div className="space-y-5">
        {scheduled && !series.active && series.pausedReason && (
          <p role="status" data-testid="series-paused" className="rounded-[18px] bg-wash px-4 py-3 text-[0.95rem]">{PAUSED[series.pausedReason] ?? "It is stopped."}</p>
        )}
        {scheduled && (
          <p className="text-[0.95rem] text-graphite" data-testid="series-month">
            Used this month: <span className="note text-ink">{amount(series.monthUsd)}</span>.
            {series.active && series.nextDueAt && ` Next video due ${day(series.nextDueAt)}.`}
          </p>
        )}
        <div className="max-w-[18rem]">
          <Field label="How often">
            <select data-testid="series-cadence" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              {Object.entries(CADENCES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        {cadence !== "manual" && (
          <p className="max-w-[44rem] text-[0.9rem] text-graphite">
            With this the series makes its videos without asking again, each one held from your credits as any video is.
            It stops, and says so here, when your credits do not cover the next one or a video is not finished. You can stop it at any time.
          </p>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex flex-wrap items-center gap-3">
          <Button tone="primary" data-testid="save-schedule" onClick={save} disabled={busy || !changed}>
            {cadence === "manual" ? "Save: only when I ask" : `Approve: ${CADENCES[cadence].toLowerCase()}, from my credits`}
          </Button>
          {scheduled && (
            <Button data-testid="series-toggle" onClick={() => send({ active: !series.active })} disabled={busy}>{series.active ? "Stop it" : "Let it go on"}</Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
