import { describe, expect, it } from "vitest";
import { SFX } from "../../src/media/sfx.js";
import { EDIT_SOUNDS, SCENE_SOUNDS, SCENE_SOUND_ABOUT } from "../../src/sounds.js";
import { RECIPES } from "../../scripts/make-sfx.js";

describe("the sound vocabulary", () => {
  it("describes every scene sound the script may name, and no edit sound", () => {
    expect(Object.keys(SCENE_SOUND_ABOUT).sort()).toEqual([...SCENE_SOUNDS].sort());
    for (const s of SCENE_SOUNDS) expect(SCENE_SOUND_ABOUT[s].length).toBeGreaterThan(8);
    for (const e of EDIT_SOUNDS) expect((SCENE_SOUNDS as readonly string[]).includes(e)).toBe(false);
  });

  it("has a table entry and a recipe for every sound, with one file each", () => {
    const names = [...EDIT_SOUNDS, ...SCENE_SOUNDS];
    expect(Object.keys(SFX).sort()).toEqual([...names].sort());
    expect(RECIPES.map((r) => r.file).sort()).toEqual(Object.values(SFX).map((s) => s.file).sort());
    expect(new Set(RECIPES.map((r) => r.file)).size).toBe(RECIPES.length);
  });

  it("makes beds the textures that last a scene, and keeps every hit short enough to mount for two seconds", () => {
    const beds = Object.entries(SFX).filter(([, v]) => v.kind === "bed").map(([k]) => k).sort();
    expect(beds).toEqual(["crowd", "engine", "fire", "rain", "wind"]);
    for (const [name, v] of Object.entries(SFX)) {
      const r = RECIPES.find((x) => x.file === v.file)!;
      if (v.kind === "hit") expect(r.seconds, name).toBeLessThanOrEqual(1.9);
      else expect(r.seconds, name).toBeGreaterThanOrEqual(3);
    }
  });
});
