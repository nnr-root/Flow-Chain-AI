import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Aspect } from "@src/config";
import { CaptionStyleName, Transition } from "@src/media/remotion/props";
import { PresetName } from "@src/presets";
import { REROLLABLE } from "@src/reroll";
import { draftArgs, Look, lookFlags, modesArg, NewVideo, RerollBody, rerenderArgs } from "@/server/schemas";
import { useStudio } from "./helpers";

const studio = useStudio();
const base = { topic: "foxes", budgetUsd: 3 };

describe("the new-video form", () => {
  it("accepts exactly the CLI's choices", () => {
    for (const aspect of Aspect.options) expect(NewVideo.parse({ ...base, aspect }).aspect).toBe(aspect);
    for (const style of PresetName.options) expect(NewVideo.parse({ ...base, style }).style).toBe(style);
    for (const captionStyle of [...CaptionStyleName.options, "preset"]) expect(NewVideo.safeParse({ ...base, captionStyle }).success).toBe(true);
    for (const transition of [...Transition.options, "auto"]) expect(NewVideo.safeParse({ ...base, transition }).success).toBe(true);
    for (const bad of [{ aspect: "1:1" }, { style: "noir" }, { captionStyle: "comic" }, { transition: "wipe" }, { scenes: 13 }, { scenes: 0 }, { topic: " " }, { budgetUsd: 0 }]) {
      expect(NewVideo.safeParse({ ...base, ...bad }).success).toBe(false);
    }
  });

  it("fills the pipeline's defaults", () => {
    expect(NewVideo.parse(base)).toMatchObject({
      aspect: "9:16", scenes: 4, style: "auto", motion: "auto", brandKit: null, music: null, musicGain: 0.35,
      hook: { mode: "gemini" }, sfx: true, sfxGain: 0.6, captionStyle: "preset", transition: "auto",
    });
  });

  it("refuses music and kit names that are not plain names", () => {
    for (const music of ["bundled:../x.mp3", "upload:a/b.mp3", "other:x.mp3", "bundled:x.wav", "/etc/passwd"]) {
      expect(NewVideo.safeParse({ ...base, music }).success).toBe(false);
    }
    for (const brandKit of ["../x", "A", "a b", ""]) expect(NewVideo.safeParse({ ...base, brandKit }).success).toBe(false);
  });

  it("becomes a `run --draft` command line, one option per field", () => {
    const minimal = draftArgs(NewVideo.parse(base), "20261006-120000-abcdef");
    expect(minimal).toEqual([
      "run", "--draft", "--yes", "--run-id", "20261006-120000-abcdef", "--topic", "foxes", "--aspect", "9:16", "--scenes", "4",
      "--mode", "auto", "--budget", "3", "--caption-style", "preset", "--transition", "auto",
      "--bgm-gain", "0.35", "--sfx-gain", "0.6",
    ]);
    const full = draftArgs(
      NewVideo.parse({
        ...base, style: "anime", motion: "stills", brandKit: "acme", music: "upload:song.mp3",
        hook: { mode: "custom", text: "Watch this" }, sfx: false, characters: "a red fox", seed: 7, voiceId: "v9",
      }),
      "20261006-120000-abcdef",
    );
    const after = (flag: string) => full[full.indexOf(flag) + 1];
    // the studio no longer chooses where pictures are made: every run is made on its own GPU endpoints
    expect(full).not.toContain("--provider");
    expect(after("--style")).toBe("anime");
    expect(after("--pin-modes")).toBe("2");
    expect(after("--brand")).toBe(join(studio.root, "brand-kits/acme"));
    expect(after("--bgm")).toBe(join(studio.root, "uploads/music/song.mp3"));
    expect(after("--hook")).toBe("Watch this");
    expect(full).toContain("--no-sfx");
    expect(after("--characters")).toBe("a red fox");
    expect(after("--seed")).toBe("7");
    expect(after("--voice")).toBe("v9");
    expect(draftArgs(NewVideo.parse({ ...base, hook: { mode: "off" }, motion: "clips" }), "x")).toEqual(expect.arrayContaining(["--no-hook", "--pin-modes", "1"]));
  });
});

describe("a look", () => {
  it("takes only the free render options", () => {
    expect(Look.safeParse({ captionStyle: "mrbeast", transition: "blur", bgmGain: 0.2, hook: false, sfx: true, sfxGain: 1, brandKit: null }).success).toBe(true);
    for (const bad of [{ seed: 1 }, { aspect: "16:9" }, { bgmGain: 2 }, { hook: "" }, { captionStyle: "comic" }]) expect(Look.safeParse(bad).success).toBe(false);
  });

  it("becomes the same flags `rerender` parses, and the matching command line", () => {
    const look = Look.parse({ captionStyle: "minimalist", transition: "glitch", bgmGain: 0.1, hook: "New title", sfx: false, sfxGain: 0.3, brandKit: null });
    expect(rerenderArgs("r1", look)).toEqual([
      "rerender", "r1", "--caption-style", "minimalist", "--transition", "glitch", "--bgm-gain", "0.1", "--hook", "New title",
      "--no-sfx", "--sfx-gain", "0.3", "--no-brand",
    ]);
    expect(rerenderArgs("r1", Look.parse({ hook: false, sfx: true }))).toEqual(["rerender", "r1", "--no-hook", "--sfx"]);
    expect(rerenderArgs("r1", Look.parse({ hookOn: true, brandKit: "acme" }))).toEqual(["rerender", "r1", "--hook-on", "--brand", join(studio.root, "brand-kits/acme")]);
    expect(rerenderArgs("r1", {})).toEqual(["rerender", "r1"]);
  });

  it("for a preview, a kit is read from its own folder and removing the brand is explicit", async () => {
    expect(await lookFlags({ bgmGain: 0.2, sfxGain: 0.5, hook: false })).toEqual({ flags: { bgmGain: "0.2", sfxGain: "0.5", hook: false } });
    expect((await lookFlags({ brandKit: null })).flags.brand).toBeNull();
    const dir = join(studio.root, "brand-kits/acme");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "logo.svg"), "<svg/>");
    await writeFile(join(dir, "brand.json"), JSON.stringify({ name: "Acme", logo: "logo.svg", colors: { accent: "#00E5FF" } }));
    const { flags, brandDir } = await lookFlags({ brandKit: "acme" });
    expect(brandDir).toBe(dir);
    expect(flags.brand).toMatchObject({ name: "Acme", logo: "logo.svg", colors: { accent: "#00E5FF" } });
    await expect(lookFlags({ brandKit: "nope" })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("other bodies", () => {
  it("a reroll names a rerollable stage and an approved amount", () => {
    for (const stage of REROLLABLE) expect(RerollBody.safeParse({ scene: 1, stage, approvedUsd: 0.1 }).success).toBe(true);
    for (const bad of [{ scene: 1, stage: "fit", approvedUsd: 0 }, { scene: 0, stage: "tts", approvedUsd: 0 }, { scene: 1, stage: "tts" }]) {
      expect(RerollBody.safeParse(bad).success).toBe(false);
    }
  });

  it("modes travel as auto,1,2", () => {
    expect(modesArg([null, 1, 2])).toBe("auto,1,2");
  });
});
