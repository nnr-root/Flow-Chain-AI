import { join, resolve } from "node:path";

/** Bundled assets that ship with the code (fonts, sound effects, the example brand kit). */
export const ASSETS_DIR = resolve(import.meta.dirname, "../assets");
export const FONTS_DIR = join(ASSETS_DIR, "fonts");
export const SFX_DIR = join(ASSETS_DIR, "sfx");
export const EXAMPLE_BRAND_DIR = join(ASSETS_DIR, "brand", "example");
