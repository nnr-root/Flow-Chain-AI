"use client";
import type { RenderProps } from "@src/media/remotion/props";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText, sendForm } from "@/lib/api";
import { StudioPlayer } from "./StudioPlayer";
import { Button, ErrorNote, Field, Panel } from "./ui";

const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
/** One sample scene for the preview: a plain backdrop, a few caption words, two seconds. */
const BACKDROP =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#24354f"/><stop offset="1" stop-color="#0d1320"/></linearGradient></defs><rect width="1080" height="1920" fill="url(#g)"/></svg>');
// 44-byte header + 0.25 s of 8 kHz 16-bit silence: enough for the narration track to exist
const SILENCE = `data:audio/wav;base64,${btoa(`RIFF${"Ô\u000f\0\0"}WAVEfmt ${"\u0010\0\0\0\u0001\0\u0001\0@\u001f\0\0\u0080>\0\0\u0002\0\u0010\0"}data${"°\u000f\0\0"}${"\0".repeat(4016)}`)}`;
const WORDS = ["Your", "captions", "look", "like", "this"];

/** A file the user picked, as a URL the page can show; released when it changes. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file]);
  return url;
}

export function KitForm({ defaultFont }: { defaultFont: { family: string; file: string; weight: number } }) {
  const router = useRouter();
  const [f, setF] = useState({ name: "", position: "top-right" as (typeof CORNERS)[number], widthPct: 14, opacity: 0.8, fontFamily: "", fontWeight: 700, textColor: "", accentColor: "#4cc9f0", characters: "" });
  const [logo, setLogo] = useState<File | null>(null);
  const [font, setFont] = useState<File | null>(null);
  const [portrait, setPortrait] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof typeof f>(key: K, value: (typeof f)[K]) => setF((old) => ({ ...old, [key]: value }));
  const logoUrl = useObjectUrl(logo);
  const fontUrl = useObjectUrl(font);

  // the same composition the videos use, fed a sample scene and the kit as it stands in the form
  const family = font ? f.fontFamily.trim() || f.name.trim() || "Brand font" : defaultFont.family;
  const props = useMemo<RenderProps>(() => {
    const per = 400;
    return {
      fps: 30, width: 1080, height: 1920, totalFrames: 60,
      scenes: [{ kind: "still", src: "backdrop", camera: "zoom_in", from: 0, frames: 60 }],
      boundaries: [],
      captions: {
        style: {
          font: { family, file: "font", weight: font ? f.fontWeight : defaultFont.weight },
          textCase: "upper", sizePctOfShortSide: 6.5, color: f.textColor || "#FFFFFF", activeColor: f.accentColor || "#FFD400",
          inactiveOpacity: 1, stroke: { color: "#000000", pctOfSize: 12 }, shadow: null, maxWordsPerPage: 5, activeAnim: "pop",
        },
        bottomPct: 30,
        pages: [{ text: WORDS.join(" "), startMs: 0, durationMs: 2000, tokens: WORDS.map((w, i) => ({ text: i === 0 ? w : ` ${w}`, fromMs: i * per, toMs: (i + 1) * per })) }],
      },
      hook: null,
      brand: logoUrl ? { logo: "logo", position: f.position, widthPct: f.widthPct, opacity: f.opacity, marginPct: 4 } : null,
      audio: { narration: "silence", bgm: null, speech: [], sfx: [] },
    };
  }, [family, font, f.fontWeight, f.textColor, f.accentColor, f.position, f.widthPct, f.opacity, logoUrl, defaultFont.weight]);
  const resolve = useCallback(
    (path: string) =>
      ({
        backdrop: BACKDROP,
        silence: SILENCE,
        logo: logoUrl ?? "",
        // Remotion's font loader reads the format from the URL's ending; a blob URL has none, so the name's is appended
        font: fontUrl && font ? `${fontUrl}#.${font.name.toLowerCase().endsWith(".otf") ? "otf" : "ttf"}` : `/api/assets/fonts/${defaultFont.file}`,
      })[path] ?? "",
    [logoUrl, fontUrl, font, defaultFont.file],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData();
    form.set("name", f.name);
    if (logo) form.set("logo", logo);
    if (font) {
      form.set("font", font);
      form.set("fontFamily", family);
      form.set("fontWeight", String(f.fontWeight));
    }
    if (portrait) form.set("portrait", portrait);
    form.set("position", f.position);
    form.set("widthPct", String(f.widthPct));
    form.set("opacity", String(f.opacity));
    if (f.textColor) form.set("textColor", f.textColor.toUpperCase());
    if (f.accentColor) form.set("accentColor", f.accentColor.toUpperCase());
    if (f.characters.trim()) form.set("characters", f.characters);
    try {
      await sendForm("/api/brand-kits", form);
      setF((old) => ({ ...old, name: "", characters: "" }));
      setLogo(null);
      setFont(null);
      setPortrait(null);
      (e.target as HTMLFormElement).reset();
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <Panel title="New brand kit">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input data-testid="kit-name" required value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Logo" hint="PNG or SVG, up to 2 MB"><input data-testid="kit-logo" type="file" required accept=".png,.svg,image/png,image/svg+xml" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} /></Field>
          <Field label="Logo corner">
            <select value={f.position} onChange={(e) => set("position", e.target.value as (typeof CORNERS)[number])}>
              {CORNERS.map((c) => <option key={c} value={c}>{c.replace("-", " ")}</option>)}
            </select>
          </Field>
          <Field label={`Logo width (${f.widthPct}% of the frame)`}><input type="range" min={5} max={40} value={f.widthPct} onChange={(e) => set("widthPct", Number(e.target.value))} className="w-full" /></Field>
          <Field label={`Logo opacity (${Math.round(f.opacity * 100)}%)`}><input type="range" min={0.1} max={1} step={0.05} value={f.opacity} onChange={(e) => set("opacity", Number(e.target.value))} className="w-full" /></Field>
          <Field label="Caption font" hint="Optional TTF or OTF, up to 5 MB"><input type="file" accept=".ttf,.otf" onChange={(e) => setFont(e.target.files?.[0] ?? null)} /></Field>
          {font && (
            <>
              <Field label="Font family name"><input value={f.fontFamily} placeholder={family} onChange={(e) => set("fontFamily", e.target.value)} /></Field>
              <Field label="Font weight"><input type="number" min={100} max={900} step={100} value={f.fontWeight} onChange={(e) => set("fontWeight", Number(e.target.value))} /></Field>
            </>
          )}
          <Field label="Caption text colour" hint="Empty = the style's own">
            <div className="flex items-center gap-2">
              <input type="color" className="h-8 w-12" aria-label="Caption text colour" value={f.textColor || "#ffffff"} onChange={(e) => set("textColor", e.target.value)} />
              {f.textColor && <Button onClick={() => set("textColor", "")}>Clear</Button>}
            </div>
          </Field>
          <Field label="Accent colour" hint="The word being spoken"><input type="color" className="h-8 w-12" aria-label="Accent colour" value={f.accentColor} onChange={(e) => set("accentColor", e.target.value)} /></Field>
          <Field label="Characters" hint="Optional. Used in every picture prompt of videos made with this kit.">
            <textarea rows={2} maxLength={600} value={f.characters} onChange={(e) => set("characters", e.target.value)} />
          </Field>
          <Field label="Character portrait" hint="Optional PNG or JPG, up to 6 MB. Every picture of a video keeps this character."><input type="file" accept=".png,.jpg,.jpeg" onChange={(e) => setPortrait(e.target.files?.[0] ?? null)} /></Field>
        </div>
        <div className="mt-4 space-y-3">
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" tone="primary" data-testid="create-kit" disabled={busy}>{busy ? "Saving…" : "Save kit"}</Button>
        </div>
      </Panel>
      <div>
        <p className="mb-2 text-xs text-dim">Preview with a sample scene</p>
        <StudioPlayer props={props} resolve={resolve} className="overflow-hidden rounded-xl border border-line bg-black" />
      </div>
    </form>
  );
}
