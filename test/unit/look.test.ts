import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { CAPTION_STYLES } from "../../src/media/remotion/styles.js";
import { PRESETS } from "../../src/presets.js";
import { captionStyleFor, effectivePreset, transitionInto } from "../../src/stages/look.js";
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
