"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorText, sendJson, usd } from "@/lib/api";
import { type Cadence, CADENCES, PAUSED, type SeriesView } from "@/lib/series";
import { Button, ErrorNote, Field, Panel } from "./ui";

const day = (iso: string): string => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * A series' schedule and the approval that goes with it (phase 6 spec §4). A series that makes videos by itself
 * spends without a click, so what stands in for the click is set here, by its owner, in two amounts: the most
 * one video may cost and the most a month's videos may. It never spends outside them, and says why when it stops.
 */
export function SeriesSchedule({ series }: { series: SeriesView }) {
  const router = useRouter();
  const [cadence, setCadence] = useState<Cadence>(series.cadence);
  const [cap, setCap] = useState(series.perVideoCapUsd ?? 0.5);
  const [budget, setBudget] = useState(series.monthlyBudgetUsd ?? 10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scheduled = series.cadence !== "manual";
  const changed = cadence !== series.cadence || (cadence !== "manual" && (cap !== series.perVideoCapUsd || budget !== series.monthlyBudgetUsd));

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
  const save = () => send({ schedule: cadence === "manual" ? { cadence } : { cadence, perVideoCapUsd: cap, monthlyBudgetUsd: budget } });

  return (
    <Panel title="By itself" aside={scheduled ? <span className="note text-[0.9rem]" data-testid="series-status">{series.active ? "Running" : "Stopped"}</span> : undefined}>
      <div className="space-y-5">
        {scheduled && !series.active && series.pausedReason && (
          <p role="status" data-testid="series-paused" className="rounded-[18px] bg-wash px-4 py-3 text-[0.95rem]">{PAUSED[series.pausedReason] ?? "It is stopped."}</p>
        )}
        {scheduled && (
          <p className="text-[0.95rem] text-graphite" data-testid="series-month">
            Used this month: <span className="note text-ink">{usd(series.monthUsd)}</span> of {usd(series.monthlyBudgetUsd ?? 0)}.
            {series.active && series.nextDueAt && ` Next video due ${day(series.nextDueAt)}.`}
          </p>
        )}
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="How often">
            <select data-testid="series-cadence" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              {Object.entries(CADENCES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          {cadence !== "manual" && (
            <>
              <Field label="Most for one video ($)" hint="A video that would cost more is not made.">
                <input data-testid="series-cap" type="number" min={0.05} max={100} step={0.05} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
              </Field>
              <Field label="Most in a month ($)" hint="It stops when its videos of the month have used this.">
                <input data-testid="series-budget" type="number" min={0.05} max={10000} step={0.5} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
              </Field>
            </>
          )}
        </div>
        {cadence !== "manual" && (
          <p className="max-w-[44rem] text-[0.9rem] text-graphite">
            With this the series makes its videos without asking again: each one is held from your credit as usual, never above the first amount, and all of a month's never above the second.
            It stops, and says so here, when either or your credit runs out. You can stop it at any time.
          </p>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex flex-wrap items-center gap-3">
          <Button tone="primary" data-testid="save-schedule" onClick={save} disabled={busy || !changed || (cadence !== "manual" && !(cap > 0 && budget >= cap))}>
            {cadence === "manual" ? "Save: only when I ask" : `Approve: up to ${usd(cap)} a video, ${usd(budget)} a month`}
          </Button>
          {scheduled && (
            <Button data-testid="series-toggle" onClick={() => send({ active: !series.active })} disabled={busy}>{series.active ? "Stop it" : "Let it go on"}</Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
