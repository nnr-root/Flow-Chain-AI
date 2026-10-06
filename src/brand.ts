import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { Corner } from "./media/remotion/props.js";

const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "must be a #RRGGBB colour");

export const Watermark = z.strictObject({
  position: Corner.default("top-right"),
  /** Logo width as a percentage of the frame width (height keeps the logo's aspect ratio). */
  widthPct: z.number().min(2).max(50).default(14),
  opacity: z.number().min(0).max(1).default(0.8),
  /** Distance from the frame edges as a percentage of the frame's short side. */
  marginPct: z.number().min(0).max(20).default(4),
});
export type Watermark = z.infer<typeof Watermark>;

const WATERMARK_DEFAULTS: Watermark = { position: "top-right", widthPct: 14, opacity: 0.8, marginPct: 4 };

const BrandFont = z.strictObject({
  family: z.string().min(1),
  file: z.string().regex(/^[^/\\]+\.(ttf|otf)$/i, "must be a .ttf or .otf file inside the kit folder"),
  weight: z.number().int().min(100).max(900),
});

/** `brand.json` in a brand kit folder (2.3 spec §6.1). Files are named relative to the kit folder. */
export const BrandKit = z.strictObject({
  name: z.string().min(1),
  logo: z.string().regex(/^[^/\\]+\.(png|svg)$/i, "must be a .png or .svg file inside the kit folder"),
  watermark: Watermark.default(WATERMARK_DEFAULTS),
  font: BrandFont.optional(),
  colors: z.strictObject({ text: Hex.optional(), accent: Hex.optional() }).optional(),
  /** Character bible used when --characters is not given (frozen into the run at creation). */
  characters: z.string().min(1).max(600).optional(),
  /** A character portrait keyframes are conditioned on (RunPod runs); replaces the generated reference. */
  reference: z.string().regex(/^[^/\\]+\.(png|jpe?g)$/i, "must be a .png or .jpg file inside the kit folder").optional(),
});
export type BrandKit = z.infer<typeof BrandKit>;

/** The kit's look as stored in a run's render options: file paths are relative to the run directory. */
export const BrandLook = z.object({
  name: z.string(),
  logo: z.string(),
  watermark: Watermark,
  font: z.object({ family: z.string(), file: z.string(), weight: z.number().int() }).optional(),
  colors: z.object({ text: Hex.optional(), accent: Hex.optional() }).optional(),
});
export type BrandLook = z.infer<typeof BrandLook>;

/** Reads and validates `<dir>/brand.json` and checks that its files exist; one clear error for any problem. */
export async function loadBrandKit(dir: string): Promise<BrandKit> {
  const where = join(dir, "brand.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(where, "utf8"));
  } catch (err) {
    throw new Error(`brand kit ${where}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const parsed = BrandKit.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`brand kit ${where} is invalid:\n${problems}`);
  }
  const kit = parsed.data;
  for (const file of [kit.logo, kit.font?.file, kit.reference]) {
    if (file && !existsSync(join(dir, file))) throw new Error(`brand kit ${where}: ${file} not found in ${dir}`);
  }
  return kit;
}

/** Copies the kit's character portrait into `<runDir>/brand/` (frozen with the run); undefined without one. */
export async function installReference(kit: BrandKit, kitDir: string, runDir: string): Promise<string | undefined> {
  if (!kit.reference) return undefined;
  await mkdir(join(runDir, "brand"), { recursive: true });
  const rel = `brand/reference${extname(kit.reference).toLowerCase()}`;
  await copyFile(join(kitDir, kit.reference), join(runDir, rel));
  return rel;
}

/** Copies the kit's logo and font into `<runDir>/brand/` and returns the look with run-relative paths. */
export async function installBrand(kit: BrandKit, kitDir: string, runDir: string): Promise<BrandLook> {
  await mkdir(join(runDir, "brand"), { recursive: true });
  const copy = async (file: string) => {
    await copyFile(join(kitDir, file), join(runDir, "brand", file));
    return `brand/${file}`;
  };
  return {
    name: kit.name,
    logo: await copy(kit.logo),
    watermark: kit.watermark,
    ...(kit.font ? { font: { ...kit.font, file: await copy(kit.font.file) } } : {}),
    ...(kit.colors ? { colors: kit.colors } : {}),
  };
}
