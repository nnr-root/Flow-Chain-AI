import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installBrand, installReference, loadBrandKit } from "../../src/brand.js";
import { tempDir } from "../helpers/media.js";

const EXAMPLE = resolve("assets/brand/example");

/** A kit folder with a logo, a font and the given brand.json. */
async function kit(json: unknown): Promise<string> {
  const dir = await tempDir("flowchain-brand-");
  await copyFile(join(EXAMPLE, "logo.svg"), join(dir, "logo.svg"));
  await copyFile(resolve("assets/fonts/Bangers-Regular.ttf"), join(dir, "Brand.ttf"));
  await writeFile(join(dir, "brand.json"), JSON.stringify(json));
  return dir;
}

describe("loadBrandKit", () => {
  it("accepts the bundled example kit and fills the watermark defaults", async () => {
    expect(await loadBrandKit(EXAMPLE)).toEqual({
      name: "Flow-Chain Example",
      logo: "logo.svg",
      watermark: { position: "top-right", widthPct: 14, opacity: 0.8, marginPct: 4 },
      colors: { accent: "#00E5FF" },
    });
    expect((await loadBrandKit(await kit({ name: "n", logo: "logo.svg" }))).watermark).toEqual({
      position: "top-right",
      widthPct: 14,
      opacity: 0.8,
      marginPct: 4,
    });
  });

  it("fails with one clear message before anything is bought", async () => {
    await expect(loadBrandKit(await kit({ name: "n", logo: "logo.svg", colors: { accent: "cyan" } }))).rejects.toThrow(
      /colors\.accent: must be a #RRGGBB colour/,
    );
    await expect(loadBrandKit(await kit({ name: "n", logo: "missing.png" }))).rejects.toThrow(/missing\.png not found/);
    await expect(loadBrandKit(await kit({ name: "n", logo: "../logo.svg" }))).rejects.toThrow(/inside the kit folder/);
    await expect(loadBrandKit(await kit({ name: "n", logo: "logo.svg", tagline: "x" }))).rejects.toThrow(/invalid/);
    await expect(loadBrandKit(await tempDir())).rejects.toThrow(/brand\.json/);
  });
});

describe("installBrand", () => {
  it("copies the logo and font into the run and stores run-relative paths", async () => {
    const dir = await kit({
      name: "Acme",
      logo: "logo.svg",
      font: { family: "Acme Sans", file: "Brand.ttf", weight: 400 },
      colors: { text: "#FFFFFF", accent: "#FF0066" },
      characters: "a red fox",
    });
    const run = await tempDir("flowchain-run-");
    await mkdir(run, { recursive: true });
    const look = await installBrand(await loadBrandKit(dir), dir, run);
    expect(look).toEqual({
      name: "Acme",
      logo: "brand/logo.svg",
      watermark: { position: "top-right", widthPct: 14, opacity: 0.8, marginPct: 4 },
      font: { family: "Acme Sans", file: "brand/Brand.ttf", weight: 400 },
      colors: { text: "#FFFFFF", accent: "#FF0066" },
    });
    expect(existsSync(join(run, "brand/logo.svg"))).toBe(true);
    expect(existsSync(join(run, "brand/Brand.ttf"))).toBe(true);
  });
});

describe("installReference", () => {
  it("copies the kit's character portrait into the run, and nothing without one", async () => {
    const dir = await kit({ name: "n", logo: "logo.svg", reference: "face.PNG" });
    await copyFile(join(EXAMPLE, "logo.svg"), join(dir, "face.PNG"));
    const run = await tempDir("flowchain-run-");
    expect(await installReference(await loadBrandKit(dir), dir, run)).toBe("brand/reference.png");
    expect(existsSync(join(run, "brand/reference.png"))).toBe(true);
    expect(await installReference(await loadBrandKit(await kit({ name: "n", logo: "logo.svg" })), dir, run)).toBeUndefined();
  });

  it("refuses a kit whose logo would be overwritten by the installed portrait", async () => {
    const dir = await kit({ name: "n", logo: "Reference.png", reference: "face.png" });
    await copyFile(join(EXAMPLE, "logo.svg"), join(dir, "Reference.png"));
    await copyFile(join(EXAMPLE, "logo.svg"), join(dir, "face.png"));
    const run = await tempDir("flowchain-run-");
    await expect(installReference(await loadBrandKit(dir), dir, run)).rejects.toThrow(/logo Reference\.png would collide/);
    expect(existsSync(join(run, "brand/reference.png"))).toBe(false);
  });

  it("refuses a portrait too big to travel as base64 in one RunPod request, before anything is installed", async () => {
    const dir = await kit({ name: "n", logo: "logo.svg", reference: "big.jpg" });
    await writeFile(join(dir, "big.jpg"), Buffer.alloc(7 * 1024 * 1024 + 1)); // 7 MiB + 1 B is just over 9 MiB as base64
    const run = await tempDir("flowchain-run-");
    await expect(installReference(await loadBrandKit(dir), dir, run)).rejects.toThrow(/portrait big\.jpg is 7\.0 MB.*shrink it/);
    expect(existsSync(join(run, "brand/reference.jpg"))).toBe(false);
    await writeFile(join(dir, "big.jpg"), Buffer.alloc(6 * 1024 * 1024));
    expect(await installReference(await loadBrandKit(dir), dir, run)).toBe("brand/reference.jpg");
  });

  it("accepts only a PNG or JPEG portrait inside the kit", async () => {
    await expect(loadBrandKit(await kit({ name: "n", logo: "logo.svg", reference: "face.gif" }))).rejects.toThrow(
      /reference: must be a .png or .jpg file/,
    );
  });
});
