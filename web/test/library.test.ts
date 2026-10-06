import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBrandKit } from "@src/brand";
import { addMusic, createKit, LIMITS, listKits, listMusic, slugify } from "@/server/library";
import { useStudio } from "./helpers";

const studio = useStudio();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 9, 9]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]);

function form(fields: Record<string, string | [Uint8Array, string]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") f.set(k, v);
    else f.set(k, new File([new Uint8Array(v[0])], v[1]));
  }
  return f;
}
const kits = () => join(studio.root, "brand-kits");

describe("brand kits", () => {
  it("creates a kit the pipeline itself loads, with files under names the studio chose", async () => {
    const kit = await createKit(
      form({
        name: "Acme Films!", logo: [SVG, "../../evil name.svg"], font: [TTF, "x.ttf"], fontFamily: "AcmeSans", fontWeight: "800",
        portrait: [JPG, "me.jpeg"], accentColor: "#00E5FF", characters: "a red fox", position: "bottom-left", widthPct: "20",
      }),
    );
    expect(kit).toEqual({ slug: "acme-films", name: "Acme Films!", logo: "logo.svg", hasFont: true, hasPortrait: true, hasCharacters: true });
    const dir = join(kits(), "acme-films");
    expect((await readdir(dir)).sort()).toEqual(["brand.json", "font.ttf", "logo.svg", "portrait.jpg"]);
    expect(await loadBrandKit(dir)).toMatchObject({
      name: "Acme Films!", logo: "logo.svg", reference: "portrait.jpg", characters: "a red fox",
      font: { family: "AcmeSans", file: "font.ttf", weight: 800 }, colors: { accent: "#00E5FF" },
      watermark: { position: "bottom-left", widthPct: 20, opacity: 0.8, marginPct: 4 },
    });
    expect(await listKits()).toEqual([kit]);
    expect((await readdir(kits())).sort()).toEqual(["acme-films"]); // no temp folder left
  });

  it("decides a file's type by its content, not by the name it was uploaded with", async () => {
    await expect(createKit(form({ name: "a", logo: [MP3, "logo.png"] }))).rejects.toThrow("the logo must be PNG or SVG");
    await expect(createKit(form({ name: "b", logo: [PNG, "l.png"], font: [PNG, "font.ttf"] }))).rejects.toThrow("the font must be TTF or OTF");
    await expect(createKit(form({ name: "c", logo: [PNG, "l.png"], portrait: [SVG, "p.png"] }))).rejects.toThrow("the portrait must be PNG or JPG");
    expect((await createKit(form({ name: "d", logo: [PNG, "whatever.svg"] }))).logo).toBe("logo.png");
  });

  it("refuses a missing name or logo, a duplicate, an oversize file and values the kit schema rejects", async () => {
    await expect(createKit(form({ logo: [PNG, "l.png"] }))).rejects.toThrow("give the kit a name");
    await expect(createKit(form({ name: "!!!", logo: [PNG, "l.png"] }))).rejects.toThrow("at least one letter or digit");
    await expect(createKit(form({ name: "x" }))).rejects.toThrow("choose a PNG or SVG file");
    const big = new Uint8Array(LIMITS.logo + 1);
    big.set(PNG);
    await expect(createKit(form({ name: "big", logo: [big, "l.png"] }))).rejects.toThrow("at most 2 MB");
    await expect(createKit(form({ name: "bad", logo: [PNG, "l.png"], accentColor: "red" }))).rejects.toMatchObject({ code: "validation" });
    await expect(createKit(form({ name: "bad", logo: [PNG, "l.png"], position: "middle" }))).rejects.toMatchObject({ code: "validation" });
    expect(existsSync(kits()) ? await readdir(kits()) : []).toEqual([]);
    await createKit(form({ name: "Twice", logo: [PNG, "l.png"] }));
    await expect(createKit(form({ name: "twice", logo: [PNG, "l.png"] }))).rejects.toThrow('a kit called "twice" already exists');
  });

  it("lets exactly one of two concurrent creates of the same name win, and leaves no temp folder", async () => {
    const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
    const results = await Promise.allSettled([
      createKit(form({ name: "Racing", logo: [PNG, "a.png"], characters: "first" })),
      createKit(form({ name: "Racing", logo: [PNG2, "b.png"], characters: "second" })),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ code: "validation", message: 'a kit called "racing" already exists' });
    const winner = results[0].status === "fulfilled" ? "first" : "second";
    const dir = join(kits(), "racing");
    expect((await readdir(dir)).sort()).toEqual(["brand.json", "logo.png"]);
    expect(await loadBrandKit(dir)).toMatchObject({ name: "Racing", characters: winner });
    expect(Buffer.from(await readFile(join(dir, "logo.png")))).toEqual(Buffer.from(winner === "first" ? PNG : PNG2));
    expect((await readdir(kits())).sort()).toEqual(["racing"]);
  });

  it("lists only folders that load as kits", async () => {
    await mkdir(join(kits(), "broken"), { recursive: true });
    await writeFile(join(kits(), "broken", "brand.json"), "{");
    await mkdir(join(kits(), "Not A Slug"), { recursive: true });
    expect(await listKits()).toEqual([]);
  });

  it("slugs are plain", () => {
    expect(slugify("  Ünïcode & Co.  ")).toBe("unicode-co");
    expect(slugify("../../etc")).toBe("etc");
  });
});

describe("music", () => {
  it("lists bundled and uploaded tracks, and stores an upload under a safe, unique name", async () => {
    await mkdir(join(studio.root, "assets/music"), { recursive: true });
    await writeFile(join(studio.root, "assets/music/example-bed.mp3"), MP3);
    await writeFile(join(studio.root, "assets/music/notes.txt"), "x");
    const first = await addMusic(form({ file: [MP3, "../My Song (final).MP3"] }));
    const second = await addMusic(form({ file: [MP3, "my song final.mp3"] }));
    expect(first).toMatchObject({ id: "upload:my-song-final.mp3", source: "upload", bytes: 6 });
    expect(second.id).toBe("upload:my-song-final-2.mp3");
    expect(Buffer.from(await readFile(join(studio.root, "uploads/music/my-song-final.mp3")))).toEqual(Buffer.from(MP3));
    expect((await listMusic()).map((t) => t.id)).toEqual(["bundled:example-bed.mp3", "upload:my-song-final-2.mp3", "upload:my-song-final.mp3"]);
  });

  it("gives two concurrent uploads of one title different names, each with its full content", async () => {
    const MP3B = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 5, 5, 5]);
    const [a, b] = await Promise.all([
      addMusic(form({ name: "Same Title", file: [MP3, "a.mp3"] })),
      addMusic(form({ name: "Same Title", file: [MP3B, "b.mp3"] })),
    ]);
    expect(a.id).not.toBe(b.id);
    expect([a.id, b.id].sort()).toEqual(["upload:same-title-2.mp3", "upload:same-title.mp3"]);
    const content = async (t: { id: string }) => Buffer.from(await readFile(join(studio.root, "uploads/music", t.id.slice("upload:".length))));
    expect(await content(a)).toEqual(Buffer.from(MP3));
    expect(await content(b)).toEqual(Buffer.from(MP3B));
  });

  it("refuses what is not an MP3", async () => {
    await expect(addMusic(form({ file: [PNG, "song.mp3"] }))).rejects.toThrow("the music file must be MP3");
    await expect(addMusic(form({}))).rejects.toThrow("choose an MP3 file");
  });
});
