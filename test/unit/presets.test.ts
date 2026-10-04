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
});
