import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { CAPTION_STYLES } from "../../src/media/remotion/styles.js";
import { PRESETS } from "../../src/presets.js";
import { captionStyleFor, effectivePreset, hookTextFor, transitionInto } from "../../src/stages/look.js";
import { fakeScript } from "../fakes/providers.js";

function manifest() {
  const m = createManifest(
    "r",
    { topic: "t", aspect: "9:16", sceneCount: 3, modes: [1, 1, 1], voiceId: "v" },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );
  m.script = fakeScript(3, { stylePreset: "anime", transitions: ["fade", "cut", "zoom_transition"] });
  return m;
}

describe("effectivePreset", () => {
  it("prefers --style, then Gemini's pick, and is null for scripts written before 2.2", () => {
    const m = manifest();
    expect(effectivePreset(m)).toBe(PRESETS.anime);
    m.request.style = "dark_fantasy";
    expect(effectivePreset(m)).toBe(PRESETS.dark_fantasy);
    m.request.style = undefined;
    m.script!.stylePreset = undefined;
    expect(effectivePreset(m)).toBeNull();
  });
});

describe("captionStyleFor", () => {
  it("uses the preset's look by default, an explicit style over it, and hormozi without a preset", () => {
    const m = manifest();
    expect(captionStyleFor(m)).toBe(PRESETS.anime.caption);
    m.request.render.captionStyle = "mrbeast";
    expect(captionStyleFor(m)).toBe(CAPTION_STYLES.mrbeast);
    m.request.render.captionStyle = "preset";
    m.script!.stylePreset = undefined;
    expect(captionStyleFor(m)).toBe(CAPTION_STYLES.hormozi);
  });
});

describe("captionStyleFor with a brand", () => {
  const brand = {
    name: "Acme",
    logo: "brand/logo.svg",
    watermark: { position: "top-right" as const, widthPct: 14, opacity: 0.8, marginPct: 4 },
    font: { family: "Acme Sans", file: "brand/Acme.ttf", weight: 700 },
    colors: { text: "#EEEEEE", accent: "#FF0066" },
  };

  it("replaces the font and colours of the preset's look, keeping the rest", () => {
    const m = manifest();
    m.request.render.brand = brand;
    expect(captionStyleFor(m)).toEqual({
      ...PRESETS.anime.caption,
      font: brand.font,
      color: "#EEEEEE",
      activeColor: "#FF0066",
    });
  });

  it("also overrides an explicit caption style, and changes only what the brand sets", () => {
    const m = manifest();
    m.request.render.captionStyle = "minimalist";
    m.request.render.brand = { ...brand, font: undefined, colors: { accent: "#FF0066" } };
    expect(captionStyleFor(m)).toEqual({ ...CAPTION_STYLES.minimalist, activeColor: "#FF0066" });
  });
});

describe("hookTextFor", () => {
  it("uses --hook text, else the script's hook; null when turned off, empty, or scripted before 2.3", () => {
    const m = manifest();
    expect(hookTextFor(m)).toBe("Foxes never sleep");
    m.request.render.hookText = "Night shift";
    expect(hookTextFor(m)).toBe("Night shift");
    m.request.render.hook = false;
    expect(hookTextFor(m)).toBeNull();
    m.request.render.hook = true;
    m.request.render.hookText = undefined;
    m.script!.hook = "   ";
    expect(hookTextFor(m)).toBeNull();
    m.script!.hook = undefined;
    expect(hookTextFor(m)).toBeNull();
  });
});

describe("transitionInto", () => {
  it("auto: the incoming scene's suggestion, zoom_transition rendered as zoom, fade when it has none", () => {
    const m = manifest();
    expect(transitionInto(m, 1)).toBe("cut");
    expect(transitionInto(m, 2)).toBe("zoom");
    m.script!.scenes[2].suggestedTransition = undefined;
    expect(transitionInto(m, 2)).toBe("fade");
  });

  it("an explicit transition applies to every cut", () => {
    const m = manifest();
    m.request.render.transition = "glitch";
    expect([1, 2].map((k) => transitionInto(m, k))).toEqual(["glitch", "glitch"]);
  });
});
