"use client";
import { DEFAULT_SCENE_SECONDS, DEFAULT_VIDEO_SECONDS, lengthInWords, VIDEO_SECONDS } from "@src/duration";
import type { SpeechLanguage, VoiceId } from "@src/voice/language";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { amount, errorText, getJson, sendForm, sendJson } from "@/lib/api";
import { CreditNote, tooLittle, useBalance } from "@/lib/balance";
import { draftCapUsd } from "@/lib/credit";
import { NOT_READY } from "@/lib/engines";
import { CAPTION_LABELS, labelOf, TRANSITION_LABELS } from "@/lib/labels";
import type { StudioHealth } from "@/server/jobs";
import type { KitSummary, Track } from "@/server/library";
import { SceneLength } from "./SceneLength";
import { type StyleCard, StylePicker } from "./StylePicker";
import { Button, ErrorNote, Field, Panel, Segmented } from "./ui";
import { nicheById } from "@src/niches";
import { FORMATS, formatClash } from "@src/formats";
import { EDITS } from "@src/edits";
import { AUDIENCE } from "@src/culture";
import { LayerPicker } from "./LayerPicker";
import { type NicheChoice, NichePicker } from "./NichePicker";
import { VoicePicker } from "./VoicePicker";

export type PresetCard = StyleCard;

const CAPTION_STYLES = ["preset", "hormozi", "mrbeast", "minimalist"];
const TRANSITIONS = ["auto", "cut", "fade", "dissolve", "blur", "zoom", "glitch"];

/** What a video can be made of, in the studio's words (the request calls them stills, auto and clips). */
const MADE_OF = [
  { value: "stills", label: "Pictures only", note: "Every scene is a generated picture that the camera moves over. It costs the least." },
  { value: "auto", label: "Pictures and clips", note: "A moving clip where something happens, a picture where little does: the script decides scene by scene." },
  { value: "clips", label: "Clips only", note: "Every scene is a generated moving clip. It costs the most." },
] as const;

/**
 * The form a video starts from. `series`: the same choices are saved as a series instead of being spent on one
 * video: there is a name and a premise in place of a topic, and nothing is bought (phase 6 spec §3).
 */
/** The two shapes a video can have, by the word a person knows each by, and where each is watched. */
const SHAPES = [
  { aspect: "9:16", name: "Vertical", where: "Shorts, Reels, TikTok" },
  { aspect: "16:9", name: "Horizontal", where: "YouTube, the web" },
] as const;

export function NewVideoForm({ health: initialHealth, kits, tracks: initialTracks, presets, topic = "", series = false, voices = {}, voiceNames = {}, languages }: { health: StudioHealth; kits: KitSummary[]; tracks: Track[]; presets: PresetCard[]; topic?: string; series?: boolean; voices?: Partial<Record<SpeechLanguage, VoiceId[]>>; voiceNames?: Partial<Record<SpeechLanguage, Partial<Record<VoiceId, { label?: string; about?: string }>>>>; languages?: SpeechLanguage[] }) {
  const router = useRouter();
  const [health, setHealth] = useState(initialHealth);
  const [tracks, setTracks] = useState(initialTracks);
  const [f, setF] = useState({
    topic, aspect: "9:16", durationSec: DEFAULT_VIDEO_SECONDS as number, sceneMin: DEFAULT_SCENE_SECONDS.min, sceneMax: DEFAULT_SCENE_SECONDS.max, style: "auto", motion: "auto", clips: "480p",
    brandKit: "", music: "", musicGain: 0.35, hookMode: "auto", hookText: "",
    sfx: true, sfxGain: 0.6, characters: "", seed: "", language: "en" as SpeechLanguage, voiceId: "narrator-m" as VoiceId, captionStyle: "preset", transition: "auto",
    name: "", premise: "",
  });
  const [niche, setNiche] = useState<NicheChoice>({ kind: "none" });
  const [format, setFormat] = useState<string | undefined>(undefined);
  const [edit, setEdit] = useState<string | undefined>(undefined);
  const [localize, setLocalize] = useState(true);
  // a niche of made-up stories cannot be told as a type of video that tells what is so (phase 8 spec §2)
  const nicheKind = niche.kind === "known" ? nicheById(niche.id)?.kind : undefined;
  const chooseNiche = (next: NicheChoice) => {
    setNiche(next);
    if (formatClash(format, next.kind === "known" ? nicheById(next.id)?.kind : undefined)) setFormat(undefined);
  };
  const audience = AUDIENCE[f.language];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // with accounts a draft holds a little credit for the script
  const balance = useBalance();
  const set = <K extends keyof typeof f>(key: K, value: (typeof f)[K]) => setF((old) => ({ ...old, [key]: value }));
  const missing = health.missing;
  const timing = { targetSec: f.durationSec, sceneSec: { min: f.sceneMin, max: f.sceneMax } };
  // what the script may cost follows from the length: a long video's script is written in several answers
  const hold = draftCapUsd(timing);
  const offline = health.queue.mode === "queue" && !(health.queue.redis && health.queue.worker);

  // A page loaded while the worker was away does not know which of its keys are set: ask again until it is
  // back, so the form opens up by itself instead of staying shut until a reload.
  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => {
      getJson<StudioHealth>("/api/health").then(
        (now) => {
          if (now.queue.mode === "queue" && !(now.queue.redis && now.queue.worker)) return;
          setHealth(now);
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
      const choices = {
        aspect: f.aspect, durationSec: f.durationSec, sceneSec: { min: f.sceneMin, max: f.sceneMax }, style: f.style, motion: f.motion, clips: f.clips,
        brandKit: f.brandKit || null, music: f.music || null, musicGain: f.musicGain,
        hook: f.hookMode === "custom" ? { mode: "custom", text: f.hookText } : { mode: f.hookMode },
        sfx: f.sfx, sfxGain: f.sfxGain, captionStyle: f.captionStyle, transition: f.transition,
        ...(f.characters.trim() ? { characters: f.characters } : {}),
        ...(f.seed.trim() ? { seed: Number(f.seed) } : {}),
        language: f.language, voiceId: f.voiceId,
        // (a niche of one's own left empty is no niche)
        niche: niche.kind === "custom" ? (niche.text.trim() ? { kind: "custom", text: niche.text.trim() } : { kind: "none" }) : niche,
        ...(format ? { format } : {}),
        ...(edit ? { edit } : {}),
        localize,
      };
      if (series) {
        const { id } = await sendJson<{ id: string }>("/api/series", { name: f.name, premise: f.premise, recipe: choices });
        router.push(`/series/${id}`);
        return;
      }
      const { runId } = await sendJson<{ runId: string }>("/api/drafts", { topic: f.topic, ...choices });
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
    <form onSubmit={submit} className="max-w-[56rem] space-y-12">
      <h1 className="display text-[clamp(2.6rem,1.6rem+4vw,4.5rem)] leading-[0.92]">{series ? "New series" : "New video"}</h1>
      <Panel title="What it is about">
        <div className="space-y-5">
          {series ? (
            <>
              <Field label="Name" hint="For you: what the series is called in your list.">
                <input data-testid="series-name" required maxLength={80} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Greek myths" />
              </Field>
              <Field label="What its videos are about" hint="One sentence. Every video of the series is written from it, each about something the series has not done yet.">
                <textarea data-testid="series-premise" required rows={2} maxLength={300} value={f.premise} onChange={(e) => set("premise", e.target.value)} placeholder="Greek myths, one god or hero at a time, told as a short dramatic story" />
              </Field>
            </>
          ) : null}
          <Field group label="Niche" hint="Optional. The script is written the way videos that hold their audience in it are.">
            <NichePicker value={niche} onChange={chooseNiche} onExample={series ? undefined : (t) => set("topic", t)} />
          </Field>
          <Field group label="Video type" hint="Optional. How it is told: how it opens, the shape it takes, how it is narrated. Goes with any niche.">
            <LayerPicker name="Video type" value={format} onChange={setFormat} noneLabel="Any" noneAbout="Told the way its niche, or its topic, suits best."
              options={FORMATS.map((t) => ({ id: t.id, label: t.label, about: t.about, ...(formatClash(t.id, nicheKind) ? { disabled: "Tells what is so: not for made-up stories" } : {}) }))} />
          </Field>
          {series ? null : (
            <Field label="Topic">
              <textarea data-testid="topic" required rows={2} maxLength={500} value={f.topic} onChange={(e) => set("topic", e.target.value)} placeholder="A lighthouse keeper's daughter takes over the light" />
            </Field>
          )}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field group label="Shape">
              {/* the word a person knows the shape by first, its ratio beside it, and where it is watched */}
              <div role="radiogroup" aria-label="Shape" className="grid grid-cols-2 gap-2">
                {SHAPES.map((shape) => {
                  const on = f.aspect === shape.aspect;
                  return (
                    <button key={shape.aspect} type="button" role="radio" aria-checked={on} data-testid={`shape-${shape.aspect}`} onClick={() => set("aspect", shape.aspect)}
                      className={`flex items-center gap-3 rounded-[16px] bg-sheet px-3 py-2.5 text-left outline-offset-2 ${on ? "outline outline-[3px] outline-signal" : "hover:outline hover:outline-1 hover:outline-ink/40"}`}>
                      <span aria-hidden className={`shrink-0 rounded-[4px] border-2 ${on ? "border-signal" : "border-graphite"} ${shape.aspect === "9:16" ? "h-7 w-4" : "h-4 w-7"}`} />
                      <span className="min-w-0">
                        <span className="block font-bold leading-tight"><span className={on ? "marked" : ""}>{shape.name}</span> <span className="text-[0.85rem] font-semibold text-graphite">{shape.aspect}</span></span>
                        <span className="block text-[0.78rem] leading-snug text-graphite">{shape.where}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Length" hint="About: a video is as long as its narration turns out.">
              <select data-testid="length" value={f.durationSec} onChange={(e) => set("durationSec", Number(e.target.value))}>
                {VIDEO_SECONDS.map((sec) => <option key={sec} value={sec}>{lengthInWords(sec)}</option>)}
              </select>
            </Field>
          </div>
          <SceneLength value={{ min: f.sceneMin, max: f.sceneMax }} onChange={(v) => setF((old) => ({ ...old, sceneMin: v.min, sceneMax: v.max }))} videoSec={f.durationSec} />
        </div>
      </Panel>

      <Panel title="Style" aside={<span className="text-[0.85rem] text-graphite">what the video looks like</span>}>
        <StylePicker styles={presets} value={f.style} onChange={(name) => set("style", name)} />
      </Panel>

      <Panel title="Edit" aside={<span className="text-[0.85rem] text-graphite">how it moves and is cut</span>}>
        <LayerPicker name="Edit" value={edit} onChange={setEdit} noneLabel="Plain" noneAbout="The camera and the cuts the script chooses, and the picture as it is drawn."
          options={EDITS.map((e) => ({ id: e.id, label: e.label, about: e.about }))} />
      </Panel>

      <Panel title="Made of">
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3 text-[0.95rem]">
            <Segmented label="What the video is made of" value={f.motion} onChange={(v) => set("motion", v)} options={MADE_OF.map(({ value, label }) => ({ value, label }))} />
            <span className="text-[0.85rem] text-graphite" data-testid="made-of-note">{MADE_OF.find((m) => m.value === f.motion)?.note} You can still change any one scene on the draft, before anything is generated.</span>
          </div>
          {/* (a video of pictures only has no clip to choose a size for) */}
          {f.motion !== "stills" && (
            <div className="flex flex-wrap items-center gap-3 text-[0.95rem]">
              <span>Moving clips in</span>
              <Segmented label="Clip quality" value={f.clips} onChange={(v) => set("clips", v)}
                options={[{ value: "480p", label: "Standard" }, { value: "720p", label: "HD (720p)" }, ...(health.fullHd ? [{ value: "1080p", label: "Full HD (1080p)" }] : [])]} />
              <span className="text-[0.85rem] text-graphite" data-testid="clips-note">
                {f.clips === "1080p"
                  ? "Every clip is sharpened to 1080p after it is made: the sharpest, at about six times the cost of a standard clip."
                  : "HD clips are sharper and cost about twice as much."}{" "}The draft shows the price before anything is made.
              </span>
            </div>
          )}
          {missing.length > 0 && <ErrorNote>{missing[0] === NOT_READY ? "The studio is not ready to make videos yet. Please try again later." : `Not set in .env: ${missing.join(", ")}. Add them in the repository's .env file.`}</ErrorNote>}
        </div>
      </Panel>

      <Panel title="Language and voice">
        <VoicePicker voices={voices} names={voiceNames} languages={languages} language={f.language} voice={f.voiceId} onLanguage={(l) => set("language", l)} onVoice={(v) => set("voiceId", v)}
          suggested={niche.kind === "known" && nicheById(niche.id) ? { ids: nicheById(niche.id)!.voices, label: nicheById(niche.id)!.label } : undefined} />
        {audience && (
          <label className="mt-5 flex items-start gap-2.5 text-[0.95rem]">
            <input type="checkbox" data-testid="localize" checked={localize} onChange={(e) => setLocalize(e.target.checked)} className="mt-1" />
            <span>
              Made for viewers in {audience}
              <span className="block text-[0.85rem] text-graphite">Where the topic leaves it open, the people and places in it are theirs; real events and people stay as they are. Turn it off for a video you will also make in other languages.</span>
            </span>
          </label>
        )}
      </Panel>

      <Panel title="Brand and sound">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
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
            <input type="file" accept=".mp3,audio/mpeg" aria-label="Upload an MP3" className="mt-2 w-full max-w-full text-[0.85rem]" onChange={(e) => void uploadMusic(e.target.files?.[0])} />
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

      <details className="ruled">
        <summary className="printed cursor-pointer text-[1.2rem] leading-none">More choices</summary>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Field label="Opening title">
            <select value={f.hookMode} onChange={(e) => set("hookMode", e.target.value)}>
              <option value="auto">Written for you</option>
              <option value="custom">My own text</option>
              <option value="off">None</option>
            </select>
            {f.hookMode === "custom" && <input className="mt-2" maxLength={60} required value={f.hookText} onChange={(e) => set("hookText", e.target.value)} placeholder="2–6 punchy words" />}
          </Field>
          <Field label="Captions">
            <select value={f.captionStyle} onChange={(e) => set("captionStyle", e.target.value)}>
              {CAPTION_STYLES.map((c) => <option key={c} value={c}>{labelOf(CAPTION_LABELS, c)}</option>)}
            </select>
          </Field>
          <Field label="Cuts between scenes">
            <select value={f.transition} onChange={(e) => set("transition", e.target.value)}>
              {TRANSITIONS.map((t) => <option key={t} value={t}>{labelOf(TRANSITION_LABELS, t)}</option>)}
            </select>
          </Field>
          <Field label="Seed" hint="Empty = random. The same seed keeps pictures repeatable.">
            <input inputMode="numeric" pattern="[0-9]*" value={f.seed} onChange={(e) => set("seed", e.target.value)} />
          </Field>
          <Field label="Characters" hint="Used in every picture prompt. Empty = the brand kit's, else written with the script.">
            <textarea rows={2} maxLength={600} value={f.characters} onChange={(e) => set("characters", e.target.value)} />
          </Field>
        </div>
      </details>

      <ErrorNote>{error}</ErrorNote>
      {series ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" tone="primary" data-testid="save-series" disabled={busy || !f.name.trim() || !f.premise.trim()}>{busy ? "Saving…" : "Save the series"}</Button>
          <span className="text-[0.85rem] text-graphite">Nothing is bought. A video of it is made when you ask for one.</span>
        </div>
      ) : (
        <>
          <CreditNote balance={balance} needUsd={hold} />
          <div className="flex items-center gap-3">
            <Button type="submit" tone="primary" data-testid="create-draft" disabled={busy || offline || missing.length > 0 || !f.topic.trim() || tooLittle(balance, hold)}>
              {busy ? "Writing the script…" : `Write the script, up to ${amount(hold)}`}
            </Button>
            <span className="text-[0.85rem] text-graphite" data-testid="create-note">
              {offline ? "The worker is offline: nothing can be started until it is back." : "Buys only the script. You preview and price the rest before generating."}
            </span>
          </div>
        </>
      )}
    </form>
  );
}
