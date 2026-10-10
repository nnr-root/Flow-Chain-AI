import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaptionStyle } from "../../src/media/remotion/props.js";
import { PresetName, PRESETS } from "../../src/presets.js";

describe("style presets", () => {
  it("has one record per name, each with a valid caption style and a bundled font", () => {
    expect(Object.keys(PRESETS).sort()).toEqual([...PresetName.options].sort());
    for (const [name, p] of Object.entries(PRESETS)) {
      expect(p.name).toBe(name);
      expect(CaptionStyle.safeParse(p.caption).success).toBe(true);
      expect(existsSync(join("assets/fonts", p.caption.font.file))).toBe(true);
    }
  });

  it("describes visual qualities only, never studios, artists or products", () => {
    const words = Object.values(PRESETS)
      .flatMap((p) => [p.description, p.artStyle, p.imagePrefix, p.imageSuffix, p.motionKeywords])
      .join(" ");
    expect(words).not.toMatch(/ghibli|pixar|disney|unreal|octane|arri|canon|nikon|sony|blade runner|greg rutkowski/i);
  });

  it("says how a picture is made and never what is in it: the picture model draws every thing a prompt names", () => {
    // (a prefix that named candles put candles on a cliff edge; phase 5 spec §9.12)
    const things = /\b(candle|lantern|street|city|town|building|skyline|rain|snow|fog|mist|smoke|sign|window|door|room|castle|forest|mountain|sea|sky|sun|moon|star|cloud|tree|flower|sword|armou?r|costume|prop|robot|car|crowd|people|person|man|woman|child|character|figure)s?\b/i;
    for (const p of Object.values(PRESETS)) {
      for (const words of [p.artStyle, p.imagePrefix, p.imageSuffix, p.motionKeywords, p.palette ?? ""]) expect(words, `${p.name}: ${words}`).not.toMatch(things);
    }
  });

  it("asks for what is wanted, not for what is not: a model without a negative prompt reads \"no outlines\" as outlines", () => {
    for (const p of Object.values(PRESETS)) {
      for (const words of [p.artStyle, p.imagePrefix, p.imageSuffix, p.motionKeywords]) expect(words, `${p.name}: ${words}`).not.toMatch(/\b(no|not|without|never|avoid|don't)\b/i);
    }
  });

  it("opens the picture prompt and the art style with the same medium, so pictures and clips are told one thing", () => {
    for (const p of Object.values(PRESETS)) {
      const medium = (words: string) => words.toLowerCase().split(",")[0].split(" ").slice(0, 2).join(" ");
      expect(medium(p.artStyle), p.name).toBe(medium(p.imagePrefix));
    }
  });

  it("gives every preset a name a person is shown and a line of its own about when it fits", () => {
    const all = Object.values(PRESETS);
    expect(new Set(all.map((p) => p.label)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.description)).size).toBe(all.length);
    for (const p of all) expect(p.label).toMatch(/^[A-Z0-9]/);
  });
});
