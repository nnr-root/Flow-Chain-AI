"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { errorText, getJson, sendForm, sendJson } from "@/lib/api";
import { CreditNote, tooLittle, useBalance } from "@/lib/balance";
import { DRAFT_CAP_USD } from "@/lib/credit";
import { NOT_READY } from "@/lib/engines";
import type { StudioHealth } from "@/server/jobs";
import type { KitSummary, Track } from "@/server/library";
import { Button, ErrorNote, Field, Panel, Segmented } from "./ui";

export type PresetCard = { name: string; description: string; font: string };

const CAPTION_STYLES = ["preset", "hormozi", "mrbeast", "minimalist"];
const TRANSITIONS = ["auto", "cut", "fade", "dissolve", "blur", "zoom", "glitch"];

export function NewVideoForm({ health: initialHealth, kits, tracks: initialTracks, presets, topic = "" }: { health: StudioHealth; kits: KitSummary[]; tracks: Track[]; presets: PresetCard[]; topic?: string }) {
  const router = useRouter();
  const [health, setHealth] = useState(initialHealth);
  const [tracks, setTracks] = useState(initialTracks);
  const [f, setF] = useState({
    topic, aspect: "9:16", scenes: 4, style: "auto", motion: "auto",
    budgetUsd: health.defaults.budgetUsd, brandKit: "", music: "", musicGain: 0.35, hookMode: "auto", hookText: "",
    sfx: true, sfxGain: 0.6, characters: "", seed: "", voiceId: "", captionStyle: "preset", transition: "auto",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // with accounts a draft holds a little credit for the script
  const balance = useBalance();
  const set = <K extends keyof typeof f>(key: K, value: (typeof f)[K]) => setF((old) => ({ ...old, [key]: value }));
  const missing = health.missing;
  const offline = health.queue.mode === "queue" && !(health.queue.redis && health.queue.worker);

  // A page loaded while the worker was away knows neither its keys nor its defaults: ask again until it is
  // back, so the form opens up by itself instead of staying shut until a reload.
  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => {
      getJson<StudioHealth>("/api/health").then(
        (now) => {
          if (now.queue.mode === "queue" && !(now.queue.redis && now.queue.worker)) return;
          setHealth(now);
          // the worker's defaults replace the stand-ins the page loaded with, unless the user chose meanwhile
          setF((old) => ({
            ...old,
            budgetUsd: old.budgetUsd === initialHealth.defaults.budgetUsd ? now.defaults.budgetUsd : old.budgetUsd,
          }));
        },
        () => {},
      );
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { runId } = await sendJson<{ runId: string }>("/api/drafts", {
        topic: f.topic, aspect: f.aspect, scenes: f.scenes, style: f.style, motion: f.motion, budgetUsd: f.budgetUsd,
        brandKit: f.brandKit || null, music: f.music || null, musicGain: f.musicGain,
        hook: f.hookMode === "custom" ? { mode: "custom", text: f.hookText } : { mode: f.hookMode },
        sfx: f.sfx, sfxGain: f.sfxGain, captionStyle: f.captionStyle, transition: f.transition,
        ...(f.characters.trim() ? { characters: f.characters } : {}),
        ...(f.seed.trim() ? { seed: Number(f.seed) } : {}),
        ...(f.voiceId.trim() ? { voiceId: f.voiceId } : {}),
      });
      router.push(`/runs/${runId}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function uploadMusic(file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    try {
      const { track } = await sendForm<{ track: Track }>("/api/music", form);
      setTracks((old) => [...old, track]);
      set("music", track.id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">New video</h1>
      <Panel title="What it is about">
        <div className="space-y-3">
          <Field label="Topic">
            <textarea data-testid="topic" required rows={2} maxLength={500} value={f.topic} onChange={(e) => set("topic", e.target.value)} placeholder="A lighthouse keeper's daughter takes over the light" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Shape">
              <select value={f.aspect} onChange={(e) => set("aspect", e.target.value)}>
                <option value="9:16">9:16 (vertical)</option>
                <option value="16:9">16:9 (wide)</option>
              </select>
            </Field>
            <Field label="Scenes">
              <input type="number" min={1} max={12} value={f.scenes} onChange={(e) => set("scenes", Number(e.target.value))} />
            </Field>
            <Field label="Budget ($)" hint="Auto motion keeps the estimate under it">
              <input type="number" min={0.1} max={100} step={0.1} value={f.budgetUsd} onChange={(e) => set("budgetUsd", Number(e.target.value))} />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel title="Style">
        <div role="radiogroup" aria-label="Style preset" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[{ name: "auto", description: "The preset that fits the topic is picked for you", font: "" }, ...presets].map((p) => (
            <button
              key={p.name}
              type="button"
              role="radio"
              aria-checked={f.style === p.name}
              onClick={() => set("style", p.name)}
              className={`rounded-lg border p-3 text-left ${f.style === p.name ? "border-accent bg-accent/10" : "border-line hover:border-dim"}`}
            >
              <span className="block text-sm font-medium">{p.name === "auto" ? "Choose for me" : p.name.replaceAll("_", " ")}</span>
              <span className="mt-1 block text-xs text-dim">{p.description}</span>
              {p.font && <span className="mt-1 block text-xs text-dim">captions: {p.font}</span>}
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Motion">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>Scenes start as</span>
            <Segmented label="Motion" value={f.motion} onChange={(v) => set("motion", v)} options={[{ value: "auto", label: "Auto" }, { value: "clips", label: "All clips" }, { value: "stills", label: "All stills" }]} />
            <span className="text-xs text-dim">You can change each scene on the draft before anything is generated.</span>
          </div>
          {missing.length > 0 && <ErrorNote>{missing[0] === NOT_READY ? "The studio is not ready to make videos yet. Please try again later." : `Not set in .env: ${missing.join(", ")}. Add them in the repository's .env file.`}</ErrorNote>}
        </div>
      </Panel>

      <Panel title="Brand and sound">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Brand kit" hint="Logo, font, colours and characters. Create kits under Brand kits.">
            <select value={f.brandKit} onChange={(e) => set("brandKit", e.target.value)}>
              <option value="">None</option>
              {kits.map((k) => <option key={k.slug} value={k.slug}>{k.name}</option>)}
            </select>
          </Field>
          <Field label="Music">
            <select value={f.music} onChange={(e) => set("music", e.target.value)}>
              <option value="">None</option>
              {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}{t.source === "upload" ? " (uploaded)" : ""}</option>)}
            </select>
            <input type="file" accept=".mp3,audio/mpeg" aria-label="Upload an MP3" className="mt-2 text-xs" onChange={(e) => void uploadMusic(e.target.files?.[0])} />
          </Field>
          {f.music && (
            <Field label={`Music level (${Math.round(f.musicGain * 100)}%)`}>
              <input type="range" min={0} max={1} step={0.05} value={f.musicGain} onChange={(e) => set("musicGain", Number(e.target.value))} className="w-full" />
            </Field>
          )}
          <Field label={`Sound effects ${f.sfx ? `(${Math.round(f.sfxGain * 100)}%)` : "(off)"}`}>
            <div className="flex items-center gap-2">
              <input type="checkbox" aria-label="Sound effects" checked={f.sfx} onChange={(e) => set("sfx", e.target.checked)} />
              <input type="range" min={0} max={1} step={0.05} value={f.sfxGain} disabled={!f.sfx} onChange={(e) => set("sfxGain", Number(e.target.value))} className="flex-1" />
            </div>
          </Field>
        </div>
      </Panel>

      <details className="rounded-xl border border-line bg-panel p-4">
        <summary className="cursor-pointer text-sm font-semibold tracking-wide text-dim uppercase">Advanced</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Hook title">
            <select value={f.hookMode} onChange={(e) => set("hookMode", e.target.value)}>
              <option value="auto">Written for you</option>
              <option value="custom">My own text</option>
              <option value="off">No hook</option>
            </select>
            {f.hookMode === "custom" && <input className="mt-2" maxLength={60} required value={f.hookText} onChange={(e) => set("hookText", e.target.value)} placeholder="2–6 punchy words" />}
          </Field>
          <Field label="Caption style">
            <select value={f.captionStyle} onChange={(e) => set("captionStyle", e.target.value)}>
              {CAPTION_STYLES.map((c) => <option key={c} value={c}>{c === "preset" ? "the style preset's" : c}</option>)}
            </select>
          </Field>
          <Field label="Transition at cuts">
            <select value={f.transition} onChange={(e) => set("transition", e.target.value)}>
              {TRANSITIONS.map((t) => <option key={t} value={t}>{t === "auto" ? "auto (the script's)" : t}</option>)}
            </select>
          </Field>
          <Field label="Seed" hint="Empty = random. The same seed keeps pictures repeatable.">
            <input inputMode="numeric" pattern="[0-9]*" value={f.seed} onChange={(e) => set("seed", e.target.value)} />
          </Field>
          <Field label="Characters" hint="Used in every picture prompt. Empty = the brand kit's, else written with the script.">
            <textarea rows={2} maxLength={600} value={f.characters} onChange={(e) => set("characters", e.target.value)} />
          </Field>
          <Field label="Voice id" hint="Empty = the studio's own voice">
            <input value={f.voiceId} onChange={(e) => set("voiceId", e.target.value)} />
          </Field>
        </div>
      </details>

      <ErrorNote>{error}</ErrorNote>
      <CreditNote balance={balance} needUsd={DRAFT_CAP_USD} />
      <div className="flex items-center gap-3">
        <Button type="submit" tone="primary" data-testid="create-draft" disabled={busy || offline || missing.length > 0 || !f.topic.trim() || tooLittle(balance, DRAFT_CAP_USD)}>
          {busy ? "Writing the script…" : "Create draft — about $0.006"}
        </Button>
        <span className="text-xs text-dim" data-testid="create-note">
          {offline ? "The worker is offline: nothing can be started until it is back." : "Buys only the script. You preview and price the rest before generating."}
        </span>
      </div>
    </form>
  );
}
