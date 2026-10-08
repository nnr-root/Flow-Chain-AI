"use client";
import type { RenderProps } from "@src/media/remotion/props";
import type { PlanJson } from "@src/studio/commands";
import type { SceneStatus } from "@src/studio/status";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ActionKind, afterRefusal } from "@/lib/approval";
import { ApiFailure, errorText, sendJson, usd } from "@/lib/api";
import { CreditNote, tooLittle, useBalance } from "@/lib/balance";
import { controlsOf, type LookControls, pendingLook } from "@/lib/look";
import { encodeLookToken } from "@/lib/look-token";
import type { KitSummary } from "@/server/library";
import type { JobView } from "@/server/jobs";
import type { RunView } from "@/server/runs";
import { StudioPlayer, type StudioPlayerHandle } from "./StudioPlayer";
import { Button, ErrorNote, Field, Panel, Segmented, StateBadge } from "./ui";

/** Player props together with the look and media version they were built for: file URLs must carry the same. */
type Preview = { props: RenderProps; draft: boolean; lookKey: string; mediaKey: string };
type Mode = 1 | 2 | null;
type RerollAsk = { scene: number; stage: string; label: string; totalUsd: number };

const CAPTION_STYLES = ["preset", "hormozi", "mrbeast", "minimalist"];
const TRANSITIONS = ["auto", "cut", "fade", "dissolve", "blur", "zoom", "glitch"];
const MARK = { pending: "·", done: "✓", failed: "✗" } as const;
const RESUMABLE = ["needs_approval", "failed", "interrupted", "incomplete"];
const REROLLS: Array<{ stage: string; label: string }> = [
  { stage: "tts", label: "voice" },
  { stage: "keyframes", label: "picture" },
  { stage: "clips", label: "clip" },
];

export function Studio({ initial, initialLog, kits }: { initial: RunView; initialLog: string[]; kits: KitSummary[] }) {
  const id = initial.runId;
  const [view, setView] = useState(initial);
  const [log, setLog] = useState(initialLog);
  const [controls, setControls] = useState<LookControls | null>(initial.status ? controlsOf(initial.status) : null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [estimate, setEstimate] = useState<PlanJson | null>(null);
  const [ask, setAsk] = useState<RerollAsk | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const player = useRef<StudioPlayerHandle>(null);
  const { status, state, job } = view;
  const scripted = status?.runSteps.find((s) => s.stage === "script")?.status === "done";
  const working = state === "running" || state === "creating" || state === "queued";
  // With accounts: what the user may still spend. A job starting or ending changes it, and the worker settles a
  // moment after the run's state changes, so it is asked for at once and once more a little later; the header's
  // figure (rendered on the server) is refreshed with it, so the page never shows two different balances.
  const router = useRouter();
  const [settled, setSettled] = useState(0);
  const balance = useBalance(`${state}:${job?.id ?? ""}:${settled}`);
  const firstState = useRef(true);
  useEffect(() => {
    if (firstState.current) {
      firstState.current = false;
      return;
    }
    router.refresh();
    const later = setTimeout(() => {
      setSettled((n) => n + 1);
      router.refresh();
    }, 3000);
    return () => clearTimeout(later);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, job?.id]);

  // live updates: the run whenever its folder changes, and new lines of the job's output
  useEffect(() => {
    const source = new EventSource(`/api/runs/${id}/events`);
    source.addEventListener("run", (e) => setView(JSON.parse((e as MessageEvent).data) as RunView));
    source.addEventListener("log", (e) => {
      const { lines } = JSON.parse((e as MessageEvent).data) as { lines: string[] };
      setLog((old) => [...old, ...lines].slice(-200));
    });
    return () => source.close();
  }, [id]);

  // the controls follow the run until the user touches them
  const savedKey = status ? JSON.stringify([status.render, status.hook]) : "";
  useEffect(() => {
    if (status) setControls(controlsOf(status));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const look = useMemo(() => (status && controls ? pendingLook(status, controls) : {}), [status, controls]);
  const lookKey = JSON.stringify(look);
  const dirty = lookKey !== "{}";
  // media under the same paths changes when the run moves on (a reroll, a finished generation): reload it then
  const mediaKey = `${state}:${job?.id ?? ""}:${status?.final?.duration ?? ""}`;

  useEffect(() => {
    if (!scripted) return;
    let stale = false;
    const timer = setTimeout(() => {
      sendJson<{ props: RenderProps; draft: boolean }>(`/api/runs/${id}/props`, { look: JSON.parse(lookKey) })
        .then((p) => {
          if (stale) return;
          setPreview({ ...p, lookKey, mediaKey });
          setPreviewError("");
        })
        .catch((err) => !stale && setPreviewError(errorText(err)));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [id, scripted, lookKey, mediaKey]);

  // The files are asked for with the look the props on screen were built for, not the look being typed: until
  // the new props arrive, the old props still name the old look's files (its caption font, its brand logo).
  const shownLook = preview?.lookKey ?? "{}";
  const shownMedia = preview?.mediaKey ?? mediaKey;
  const resolve = useCallback(
    (path: string) => `/api/runs/${id}/files/${encodeLookToken({ v: shownMedia, look: JSON.parse(shownLook) })}/${path}`,
    [id, shownMedia, shownLook],
  );

  // what continuing would cost, whenever there is something to continue
  const needsEstimate = state === "draft" || RESUMABLE.includes(state);
  const modesKey = status?.scenes.map((s) => s.override ?? "a").join(",") ?? "";
  useEffect(() => {
    // a price for the old state or modes must not stay clickable while (or if) the new one is fetched
    setEstimate(null);
    if (!needsEstimate) return;
    let stale = false;
    sendJson<PlanJson>(`/api/runs/${id}/plan`, {}).then((p) => !stale && setEstimate(p), (err) => !stale && setError(errorText(err)));
    return () => {
      stale = true;
    };
  }, [id, needsEstimate, modesKey, state]);

  /** Runs an action, showing its error; an estimate that rose replaces the figure of that action on screen so the user can approve it. */
  const act = async (fn: () => Promise<unknown>, action?: ActionKind) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      if (action && err instanceof ApiFailure && err.code === "estimate_changed" && typeof err.data.totalUsd === "number") {
        const totalUsd = err.data.totalUsd;
        setEstimate((old) => afterRefusal(action, totalUsd, { estimate: old, ask: null }).estimate);
        setAsk((old) => afterRefusal(action, totalUsd, { estimate: null, ask: old }).ask);
      }
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  /** Starts a job and shows it at once: waiting for the events stream would leave a paid button enabled meanwhile. */
  const start = async (action: string, body: unknown) => {
    const { job: started } = await sendJson<{ job: JobView }>(`/api/runs/${id}/${action}`, body);
    // unless the stream was faster: what it says about this job (even that it already ended) is newer than the answer
    setView((v) => (v.job?.id === started.id ? v : { ...v, job: started, state: started.state === "queued" ? "queued" : "running" }));
  };
  const setMode = (scene: number, mode: Mode) =>
    act(async () => {
      const modes = status!.scenes.map((s) => (s.scene === scene ? mode : s.override));
      setEstimate(await sendJson<PlanJson>(`/api/runs/${id}/modes`, { modes }));
    });
  // the preview shows the look being edited, so that is the look the bought video gets: save it first (a failed save stops here)
  const generate = () =>
    act(async () => {
      if (dirty) await sendJson(`/api/runs/${id}/look`, { look });
      await start("generate", { approvedUsd: estimate!.totalUsd });
    }, "generate");
  const stop = () => act(() => sendJson(`/api/runs/${id}/job`, {}, "DELETE"));
  const unlock = () => act(() => sendJson(`/api/runs/${id}/unlock`));
  const saveLook = () => act(() => sendJson(`/api/runs/${id}/look`, { look }));
  const rerender = () => act(() => start("rerender", { look }));
  const askReroll = (scene: number, stage: string, label: string) =>
    act(async () => {
      const plan = await sendJson<PlanJson>(`/api/runs/${id}/plan`, { reroll: { scene, stage } });
      setAsk({ scene, stage, label, totalUsd: plan.totalUsd });
    });
  // a reroll renders the video again, so like generate it first saves the look the preview shows
  const confirmReroll = () =>
    act(async () => {
      if (dirty) await sendJson(`/api/runs/${id}/look`, { look });
      await start("reroll", { scene: ask!.scene, stage: ask!.stage, approvedUsd: ask!.totalUsd });
      setAsk(null);
    }, "reroll");

  const failures = status ? [...status.runSteps, ...status.scenes.flatMap((s) => s.steps.map((x) => ({ ...x, scene: s.scene })))].filter((s) => s.status === "failed") : [];
  const set = <K extends keyof LookControls>(key: K, value: LookControls[K]) => setControls((c) => (c ? { ...c, [key]: value } : c));

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 truncate text-xl font-semibold">{status?.title ?? status?.topic ?? "New video"}</h1>
          <StateBadge state={state} />
        </div>
        {status && <p className="text-sm text-dim">{status.topic}</p>}
        {preview ? (
          <>
            {preview.draft && (
              <p data-testid="draft-note" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                Draft preview: placeholder pictures, estimated timing, no voice yet. Captions, hook, transitions, brand, music and sound effects are real.
              </p>
            )}
            <StudioPlayer ref={player} props={preview.props} resolve={resolve} className="overflow-hidden rounded-xl border border-line bg-black" />
            <SceneStrip props={preview.props} scenes={status?.scenes ?? []} onSeek={(frame) => player.current?.seekTo(frame)} />
          </>
        ) : (
          <div className="grid aspect-[9/16] place-items-center rounded-xl border border-line bg-panel text-sm text-dim">
            {previewError || (state === "queued" ? "Waiting in line…" : working ? "Writing the script…" : "No preview yet")}
          </div>
        )}
        {state === "done" && (
          <a className="inline-block text-sm text-accent hover:underline" href={`/api/runs/${id}/files/${encodeLookToken({ v: mediaKey })}/final.mp4`} download={`${id}.mp4`}>
            Download the rendered MP4
          </a>
        )}
      </div>

      <div className="space-y-4">
        <ErrorNote>{error}</ErrorNote>

        <Panel title="Next step" aside={status && <span className="text-sm text-dim">spent so far {usd(status.spendUsd)}</span>}>
          {working && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm" data-testid="working">
                {job?.state === "queued" ? `Waiting in line: ${ordinal(job.position)} (${job.kind}). Nothing is spent while it waits.` : job ? `Working: ${job.kind}…` : "Starting…"}
              </p>
              <Button tone="danger" data-testid="stop" onClick={stop} disabled={busy || (state !== "running" && state !== "queued")}>
                {state === "queued" ? "Remove from queue" : "Stop"}
              </Button>
            </div>
          )}
          {state === "draft" && (
            <div className="space-y-3">
              <p className="text-sm text-dim">Only the script is bought. Check the preview, set each scene to a clip or a still below, then generate.</p>
              <Button tone="primary" data-testid="generate" onClick={generate} disabled={busy || !estimate || tooLittle(balance, estimate?.totalUsd)}>
                {estimate ? `Generate video — up to ${usd(estimate.totalUsd)}` : "Pricing…"}
              </Button>
              <CreditNote balance={balance} needUsd={estimate?.totalUsd} />
            </div>
          )}
          {RESUMABLE.includes(state) && (
            <div className="space-y-3">
              <p className="text-sm">
                {state === "needs_approval" && "The estimate rose above what you approved. Nothing more was bought."}
                {state === "failed" && "A step failed. What was already bought is kept."}
                {state === "interrupted" && "The job stopped without finishing (a crash or a restart)."}
                {state === "incomplete" && "This run is not finished."}
              </p>
              {failures.map((f, i) => (
                <p key={i} className="rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">
                  {f.stage}{"scene" in f ? ` scene ${f.scene}` : ""}: {f.error}
                </p>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button tone="primary" data-testid="generate" onClick={generate} disabled={busy || !estimate || tooLittle(balance, estimate?.totalUsd)}>
                  {estimate ? `${state === "needs_approval" ? "Approve and continue" : "Resume"} — up to ${usd(estimate.totalUsd)}` : "Pricing…"}
                </Button>
                {view.staleLock && <Button onClick={unlock} disabled={busy}>Clear the stale lock</Button>}
              </div>
            </div>
          )}
          {state === "done" && <p className="text-sm text-dim">Finished. Change the look below and re-render for free, or regenerate a single scene.</p>}
          <p className="mt-3 text-xs text-dim">Amounts are estimates from the price table, not invoices.</p>
        </Panel>

        {status && scripted && (
          <Panel title="Scenes">
            <ul className="space-y-3">
              {status.scenes.map((s) => (
                <SceneRow
                  key={s.scene}
                  scene={s}
                  draft={state === "draft"}
                  canReroll={!working && (state === "done" || RESUMABLE.includes(state))}
                  busy={busy}
                  onMode={(mode) => setMode(s.scene, mode)}
                  onReroll={(stage, label) => askReroll(s.scene, stage, label)}
                />
              ))}
            </ul>
            {ask && (
              <div role="dialog" aria-label="Confirm regeneration" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
                <span className="flex-1">New {ask.label} for scene {ask.scene}, and whatever follows from it: {ask.totalUsd > 0 ? `up to ${usd(ask.totalUsd)}` : "free"}.</span>
                <Button tone="primary" onClick={confirmReroll} disabled={busy}>Confirm</Button>
                <Button onClick={() => setAsk(null)}>Cancel</Button>
              </div>
            )}
          </Panel>
        )}

        {status && controls && scripted && (
          <Panel title="Look" aside={<span className="text-xs text-dim">changes preview at once and never cost anything</span>}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Caption style">
                <select data-testid="caption-style" value={controls.captionStyle} onChange={(e) => set("captionStyle", e.target.value)}>
                  {CAPTION_STYLES.map((c) => <option key={c} value={c}>{c === "preset" ? "the style preset's" : c}</option>)}
                </select>
              </Field>
              <Field label="Transition at cuts">
                <select value={controls.transition} onChange={(e) => set("transition", e.target.value)}>
                  {TRANSITIONS.map((t) => <option key={t} value={t}>{t === "auto" ? "auto (the script's)" : t}</option>)}
                </select>
              </Field>
              <Field label="Hook title">
                <div className="flex items-center gap-2">
                  <input type="checkbox" aria-label="Show the hook" checked={controls.hookOn} onChange={(e) => set("hookOn", e.target.checked)} />
                  <input value={controls.hookText} maxLength={60} disabled={!controls.hookOn} onChange={(e) => set("hookText", e.target.value)} />
                </div>
              </Field>
              <Field label="Brand">
                <select value={controls.brand} onChange={(e) => set("brand", e.target.value)}>
                  <option value="keep">{status.render.brand ? `keep “${status.render.brand.name}”` : "none"}</option>
                  {status.render.brand && <option value="none">remove the brand</option>}
                  {kits.map((k) => <option key={k.slug} value={k.slug}>apply “{k.name}”</option>)}
                </select>
              </Field>
              <Field label={`Sound effects ${controls.sfx ? `(${Math.round(controls.sfxGain * 100)}%)` : "(off)"}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" aria-label="Sound effects" checked={controls.sfx} onChange={(e) => set("sfx", e.target.checked)} />
                  <input type="range" min={0} max={1} step={0.05} value={controls.sfxGain} disabled={!controls.sfx} onChange={(e) => set("sfxGain", Number(e.target.value))} className="flex-1" />
                </div>
              </Field>
              {status.bgm && (
                <Field label={`Music level (${Math.round(controls.bgmGain * 100)}%)`}>
                  <input type="range" min={0} max={1} step={0.05} value={controls.bgmGain} onChange={(e) => set("bgmGain", Number(e.target.value))} className="w-full" />
                </Field>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {state === "done" ? (
                <Button tone="primary" data-testid="apply-look" onClick={rerender} disabled={busy || !dirty}>Apply and re-render (free)</Button>
              ) : (
                <Button tone="primary" data-testid="save-look" onClick={saveLook} disabled={busy || !dirty || working}>Save this look (free)</Button>
              )}
              <Button onClick={() => setControls(controlsOf(status))} disabled={!dirty}>Reset</Button>
            </div>
          </Panel>
        )}

        {status && status.ledger.length > 0 && (
          <Panel title="Spend" aside={<span className="text-sm">{usd(status.spendUsd)}</span>}>
            <table className="w-full text-sm">
              <tbody>
                {spendByStage(status.ledger).map(([stage, n, total]) => (
                  <tr key={stage} className="border-t border-line first:border-0">
                    <td className="py-1">{stage}</td>
                    <td className="py-1 text-dim">{n} call{n === 1 ? "" : "s"}</td>
                    <td className="py-1 text-right tabular-nums">{usd(total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        {log.length > 0 && (
          <details className="rounded-xl border border-line bg-panel p-4" open={working}>
            <summary className="cursor-pointer text-sm font-semibold tracking-wide text-dim uppercase">Job output</summary>
            <pre data-testid="log" className="mt-3 max-h-64 overflow-auto text-xs leading-5 whitespace-pre-wrap text-dim">{log.join("\n")}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

/** 1 → "next", 2 → "2nd", … for a place in the queue's line. */
function ordinal(n: number): string {
  if (n <= 1) return "next";
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}

function spendByStage(ledger: Array<{ stage: string; usd: number }>): Array<[string, number, number]> {
  const by = new Map<string, [number, number]>();
  for (const e of ledger) {
    const [n, total] = by.get(e.stage) ?? [0, 0];
    by.set(e.stage, [n + 1, total + e.usd]);
  }
  return [...by].map(([stage, [n, total]]) => [stage, n, total]);
}

/** One block per scene, as wide as its share of the video; a click seeks to its first frame. */
function SceneStrip({ props, scenes, onSeek }: { props: RenderProps; scenes: SceneStatus[]; onSeek: (frame: number) => void }) {
  return (
    <div className="flex gap-1" aria-label="Scenes">
      {props.scenes.map((s, i) => (
        <button
          key={i}
          type="button"
          data-testid={`seek-${i + 1}`}
          onClick={() => onSeek(s.from)}
          style={{ flexGrow: s.frames, flexBasis: 0 }}
          title={scenes[i]?.narration}
          className="min-w-0 rounded-md border border-line bg-panel px-1.5 py-1 text-left text-[11px] leading-4 hover:border-accent"
        >
          <span className="block font-medium">{i + 1}</span>
          <span className="block truncate text-dim">{scenes[i] ? `${scenes[i].mode === 1 ? "clip" : "still"} · ${(s.frames / props.fps).toFixed(1)}s` : ""}</span>
        </button>
      ))}
    </div>
  );
}

function SceneRow({ scene, draft, canReroll, busy, onMode, onReroll }: {
  scene: SceneStatus; draft: boolean; canReroll: boolean; busy: boolean;
  onMode: (mode: Mode) => void; onReroll: (stage: string, label: string) => void;
}) {
  const has = (stage: string) => scene.steps.some((s) => s.stage === stage);
  return (
    <li className="rounded-lg border border-line p-3" data-testid={`scene-${scene.scene}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-dim">
        <span className="rounded bg-line px-1.5 py-0.5 font-medium text-white">Scene {scene.scene}</span>
        {scene.shot && <span>{scene.shot}</span>}
        {scene.actionLevel && <span>{scene.actionLevel} action</span>}
        <span>{scene.mode === 1 ? "clip" : "still"}{scene.modeReason ? ` (${scene.modeReason})` : draft ? " (provisional)" : ""}</span>
        {scene.audioSec !== undefined && <span>{scene.audioSec.toFixed(1)} s</span>}
        <span className="ml-auto">
          {draft ? (
            <Segmented<"auto" | "1" | "2">
              label={`Scene ${scene.scene} mode`}
              value={scene.override === null ? "auto" : (String(scene.override) as "1" | "2")}
              disabled={busy}
              options={[{ value: "auto", label: "Auto" }, { value: "1", label: "Clip" }, { value: "2", label: "Still" }]}
              onChange={(v) => onMode(v === "auto" ? null : (Number(v) as 1 | 2))}
            />
          ) : (
            <span className="font-mono">{scene.steps.map((s) => `${s.stage} ${MARK[s.status]}`).join("  ")}</span>
          )}
        </span>
      </div>
      <p className="mt-2 text-sm">{scene.narration}</p>
      <p className="mt-1 text-xs text-dim">{scene.imagePrompt}</p>
      {canReroll && (
        <div className="mt-2 flex flex-wrap gap-2">
          {REROLLS.filter((r) => has(r.stage)).map((r) => (
            <Button key={r.stage} className="!px-2 !py-1 !text-xs" disabled={busy} onClick={() => onReroll(r.stage, r.label)}>New {r.label}</Button>
          ))}
          {has("reference") && <Button className="!px-2 !py-1 !text-xs" disabled={busy} onClick={() => onReroll("reference", "character portrait")}>New portrait</Button>}
        </div>
      )}
    </li>
  );
}
