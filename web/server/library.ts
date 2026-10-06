import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { BrandKit, loadBrandKit } from "@src/brand";
import { roots } from "./config";
import { ApiError } from "./http";
import { Slug } from "./schemas";

const MB = 1024 * 1024;
export const LIMITS = { logo: 2 * MB, font: 5 * MB, portrait: 6 * MB, music: 20 * MB } as const;

export type KitSummary = { slug: string; name: string; logo: string; hasFont: boolean; hasPortrait: boolean; hasCharacters: boolean };

/** Kits in `brand-kits/`; a folder that does not load as a kit is skipped, not an error for the whole list. */
export async function listKits(): Promise<KitSummary[]> {
  const { brandKits } = roots();
  if (!existsSync(brandKits)) return [];
  const out: KitSummary[] = [];
  for (const slug of (await readdir(brandKits)).sort()) {
    if (!Slug.safeParse(slug).success) continue;
    try {
      const kit = await loadBrandKit(join(brandKits, slug));
      out.push({ slug, name: kit.name, logo: kit.logo, hasFont: !!kit.font, hasPortrait: !!kit.reference, hasCharacters: !!kit.characters });
    } catch {
      // not a usable kit
    }
  }
  return out;
}

export const slugify = (name: string): string =>
  name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

type Upload = { bytes: Uint8Array; ext: string };

/** An uploaded file's bytes, with its type decided by content (never by the name the browser sent). */
async function upload(file: File, what: string, limit: number, kinds: Record<string, (b: Uint8Array) => boolean>): Promise<Upload> {
  if (file.size === 0) throw new ApiError("validation", `the ${what} is empty`);
  if (file.size > limit) throw new ApiError("validation", `the ${what} is ${(file.size / MB).toFixed(1)} MB; at most ${limit / MB} MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = Object.keys(kinds).find((k) => kinds[k](bytes));
  if (!ext) throw new ApiError("validation", `the ${what} must be ${Object.keys(kinds).map((k) => k.slice(1).toUpperCase()).join(" or ")}`);
  return { bytes, ext };
}

const starts = (b: Uint8Array, ...sig: number[]) => sig.every((v, i) => b[i] === v);
const text = (b: Uint8Array, n = 512) => new TextDecoder().decode(b.subarray(0, n));
const KIND = {
  png: (b: Uint8Array) => starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  jpg: (b: Uint8Array) => starts(b, 0xff, 0xd8, 0xff),
  svg: (b: Uint8Array) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text(b, 2048)),
  ttf: (b: Uint8Array) => starts(b, 0x00, 0x01, 0x00, 0x00) || text(b, 4) === "true",
  otf: (b: Uint8Array) => text(b, 4) === "OTTO",
  mp3: (b: Uint8Array) => text(b, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
};

const file = (form: FormData, key: string): File | null => {
  const v = form.get(key);
  return v instanceof File && v.size > 0 ? v : null;
};
const field = (form: FormData, key: string): string | undefined => {
  const v = form.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const num = (form: FormData, key: string): number | undefined => {
  const v = field(form, key);
  return v === undefined ? undefined : Number(v);
};

/**
 * Creates `brand-kits/<slug>/` from a form: files are stored under names the studio chooses, `brand.json` is
 * written, and the pipeline's own `loadBrandKit` has the last word. A kit that does not load is removed again.
 */
export async function createKit(form: FormData): Promise<KitSummary> {
  const name = field(form, "name");
  if (!name) throw new ApiError("validation", "name: give the kit a name");
  const slug = slugify(name);
  if (!Slug.safeParse(slug).success) throw new ApiError("validation", "name: use at least one letter or digit");
  const dir = join(roots().brandKits, slug);
  if (existsSync(dir)) throw new ApiError("validation", `a kit called "${slug}" already exists`);
  const logoFile = file(form, "logo");
  if (!logoFile) throw new ApiError("validation", "logo: choose a PNG or SVG file");

  const logo = await upload(logoFile, "logo", LIMITS.logo, { ".png": KIND.png, ".svg": KIND.svg });
  const fontFile = file(form, "font");
  const font = fontFile ? await upload(fontFile, "font", LIMITS.font, { ".ttf": KIND.ttf, ".otf": KIND.otf }) : null;
  const portraitFile = file(form, "portrait");
  const portrait = portraitFile ? await upload(portraitFile, "portrait", LIMITS.portrait, { ".png": KIND.png, ".jpg": KIND.jpg }) : null;

  const text = field(form, "textColor");
  const accent = field(form, "accentColor");
  const json = {
    name,
    logo: `logo${logo.ext}`,
    watermark: {
      position: field(form, "position") ?? "top-right",
      widthPct: num(form, "widthPct") ?? 14,
      opacity: num(form, "opacity") ?? 0.8,
      marginPct: num(form, "marginPct") ?? 4,
    },
    ...(font ? { font: { family: field(form, "fontFamily") ?? name, file: `font${font.ext}`, weight: num(form, "fontWeight") ?? 700 } } : {}),
    ...(text || accent ? { colors: { ...(text ? { text } : {}), ...(accent ? { accent } : {}) } } : {}),
    ...(field(form, "characters") ? { characters: field(form, "characters") } : {}),
    ...(portrait ? { reference: `portrait${portrait.ext}` } : {}),
  };
  const parsed = BrandKit.safeParse(json);
  if (!parsed.success) {
    throw new ApiError("validation", parsed.error.issues.map((i) => `${i.path.join(".") || "kit"}: ${i.message}`).join("; "));
  }

  // built in a temp folder and renamed, so a half-written kit is never listed
  const tmp = `${dir}.tmp-${process.pid}`;
  try {
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, json.logo), logo.bytes);
    if (font) await writeFile(join(tmp, `font${font.ext}`), font.bytes);
    if (portrait) await writeFile(join(tmp, `portrait${portrait.ext}`), portrait.bytes);
    await writeFile(join(tmp, "brand.json"), `${JSON.stringify(parsed.data, null, 2)}\n`);
    await loadBrandKit(tmp);
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err instanceof ApiError ? err : new ApiError("validation", err instanceof Error ? err.message : String(err));
  }
  return { slug, name, logo: json.logo, hasFont: !!font, hasPortrait: !!portrait, hasCharacters: !!json.characters };
}

export type Track = { id: string; name: string; source: "bundled" | "upload"; bytes: number };

async function tracksIn(dir: string, source: Track["source"]): Promise<Track[]> {
  if (!existsSync(dir)) return [];
  const out: Track[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (extname(name).toLowerCase() !== ".mp3" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
    out.push({ id: `${source}:${name}`, name: name.replace(/\.mp3$/i, ""), source, bytes: (await stat(join(dir, name))).size });
  }
  return out;
}

export async function listMusic(): Promise<Track[]> {
  const r = roots();
  return [...(await tracksIn(r.music, "bundled")), ...(await tracksIn(r.uploads, "upload"))];
}

/** Stores an uploaded MP3 under a name made from its title; an existing name gets a numeric suffix. */
export async function addMusic(form: FormData): Promise<Track> {
  const f = file(form, "file");
  if (!f) throw new ApiError("validation", "file: choose an MP3 file");
  const { bytes } = await upload(f, "music file", LIMITS.music, { ".mp3": KIND.mp3 });
  const base = slugify(field(form, "name") ?? f.name.replace(/\.[^.]+$/, "")) || "track";
  const { uploads } = roots();
  await mkdir(uploads, { recursive: true });
  let name = `${base}.mp3`;
  for (let n = 2; existsSync(join(uploads, name)); n++) name = `${base}-${n}.mp3`;
  await writeFile(join(uploads, name), bytes);
  return { id: `upload:${name}`, name: name.replace(/\.mp3$/, ""), source: "upload", bytes: bytes.length };
}
