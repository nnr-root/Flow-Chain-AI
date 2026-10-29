import { describe, expect, it } from "vitest";
import { createManifest } from "../../src/manifest/store.js";
import { wordsToCaptions } from "../../src/media/remotion/caption-pages.js";
import { RenderProps } from "../../src/media/remotion/props.js";
import { CAPTION_STYLES } from "../../src/media/remotion/styles.js";
import { PRESETS } from "../../src/presets.js";
import { sfxCues } from "../../src/media/sfx.js";
import { buildRenderProps } from "../../src/stages/build-render-props.js";
import { globalWords } from "../../src/stages/captions.js";
import { fakeScript } from "../fakes/providers.js";

/** Three scenes: 1 → 2 is a continue seam (both Mode 1), 2 → 3 is a cut into a Mode 2 still. */
function manifest() {
  const m = createManifest(
    "r",
    {
      topic: "t",
      aspect: "9:16",
      sceneCount: 3,
      modes: [1, 1, 2],
      voiceId: "v",
      bgm: "/music/song.mp3",
      render: { captionStyle: "minimalist", transition: "dissolve", bgmGain: 0.5, hook: false, sfx: true, sfxGain: 0.6 },
    },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );
  m.script = fakeScript(3, { shots: ["cut", "continue", "cut"], cameras: ["zoom_in", "zoom_in", "pan_left"] });
  const durations = [1.5, 1.0, 2.0]; // → frames 45, 30, 60
  m.scenes.forEach((s, i) => {
    s.audio = {
      path: `audio/scene_0${i + 1}.wav`,
      duration: durations[i],
      removedSec: 0,
      words: [{ text: `w${i + 1}`, start: 0.1, end: 0.6 }],
    };
  });
  m.scenes[0].fitted = { path: "fitted/scene_01.mp4", frames: 45, plan: { kind: "trim" } };
  m.scenes[1].fitted = { path: "fitted/scene_02.mp4", frames: 30, plan: { kind: "trim" } };
  return m;
}

const opts = { dir: "/run", fontsDir: "/fonts", sfxDir: "/sfx", fps: 30, size: { width: 1080, height: 1920 } };

describe("buildRenderProps", () => {
  const m = manifest();
  const { props, files } = buildRenderProps(m, opts, wordsToCaptions(globalWords(m), 6));

  it("lays scenes out on the cumulative frame grid: fitted clips for Mode 1, the keyframe for Mode 2", () => {
    expect(props.totalFrames).toBe(135);
    expect(props.scenes).toEqual([
      { kind: "video", src: "fitted/scene_01.mp4", from: 0, frames: 45 },
      { kind: "video", src: "fitted/scene_02.mp4", from: 45, frames: 30 },
      { kind: "still", src: "images/keyframe_03.png", camera: "pan_left", from: 75, frames: 60 },
    ]);
  });

  it("keeps continue seams as hard cuts and puts the run's transition on cuts", () => {
    expect(props.boundaries).toEqual([
      { frame: 45, kind: "seam", transition: "cut", halfWindow: 0 },
      { frame: 75, kind: "cut", transition: "dissolve", halfWindow: 5 },
    ]);
  });

  it("uses the run's caption style, placed for portrait", () => {
    expect(props.captions.style).toEqual(CAPTION_STYLES.minimalist);
    expect(props.captions.bottomPct).toBe(30);
    // a page also ends once it spans more than 1.5 s (w1 at 0.1 s … w2 ends at 2.1 s)
    expect(props.captions.pages.map((p) => p.text)).toEqual(["w1 w2", "w3"]);
  });

  it("ducks the BGM under speech and publishes every file it references", () => {
    expect(props.audio.bgm).toEqual({ src: "bgm.mp3", gain: 0.5, duckTo: 0.4, rampFrames: 10, fadeOutFrames: 30 });
    expect(props.audio.sfx).toEqual([]); // no hook, a seam and a dissolve: all quiet
    expect(props.hook).toBeNull();
    expect(props.audio.speech).toEqual([
      { from: 0, to: 21 },
      { from: 45, to: 66 },
      { from: 75, to: 96 },
    ]);
    expect(files).toEqual({
      "fitted/scene_01.mp4": "/run/fitted/scene_01.mp4",
      "fitted/scene_02.mp4": "/run/fitted/scene_02.mp4",
      "images/keyframe_03.png": "/run/images/keyframe_03.png",
      "Inter-SemiBold.ttf": "/fonts/Inter-SemiBold.ttf",
      "bgm.mp3": "/music/song.mp3",
      "narration.wav": "/run/narration.wav",
    });
  });

  it("produces props that pass the render contract", () => {
    expect(RenderProps.safeParse(props).success).toBe(true);
  });

  it("uses the landscape caption position for 16:9", () => {
    const wide = buildRenderProps(m, { ...opts, size: { width: 1920, height: 1080 } }, []);
    expect(wide.props.captions.bottomPct).toBe(12);
  });
});

describe("buildRenderProps with auto transitions and the preset's captions", () => {
  const m = manifest();
  m.request.render = { captionStyle: "preset", transition: "auto", bgmGain: 0.5, hook: true, sfx: true, sfxGain: 0.5 };
  m.script = {
    ...fakeScript(3, { shots: ["cut", "continue", "cut"], transitions: ["fade", "dissolve", "zoom_transition"] }),
    stylePreset: "cyberpunk",
  };
  const { props, files } = buildRenderProps(m, opts, []);

  it("uses the incoming scene's suggested transition at each cut, and keeps seams hard cuts", () => {
    expect(props.boundaries).toEqual([
      { frame: 45, kind: "seam", transition: "cut", halfWindow: 0 }, // Gemini suggested dissolve: ignored at a seam
      { frame: 75, kind: "cut", transition: "zoom", halfWindow: 5 },
    ]);
  });

  it("shows the script's hook over scene 1 (at most 3 s) with the snap zoom", () => {
    expect(props.hook).toEqual({ text: "Foxes never sleep", endFrame: 45, zoomFrom: 1.15, zoomFrames: 12 });
  });

  it("plays an impact under the hook and a whoosh into the zoom cut (peaking on it), and publishes both", () => {
    expect(props.audio.sfx).toEqual([
      { src: "sfx/impact_boom.mp3", frame: 0, gain: 0.5 },
      { src: "sfx/whoosh.mp3", frame: 67, gain: 0.4 },
    ]);
    expect(files["sfx/impact_boom.mp3"]).toBe("/sfx/impact_boom.mp3");
    expect(files["sfx/whoosh.mp3"]).toBe("/sfx/whoosh.mp3");
  });

  it("uses --hook text over the script's, and drops the hook and its impact when turned off", () => {
    const own = structuredClone(m);
    own.request.render.hookText = "Night shift";
    expect(buildRenderProps(own, opts, []).props.hook?.text).toBe("Night shift");
    const off = structuredClone(m);
    off.request.render.hook = false;
    const p = buildRenderProps(off, opts, []).props;
    expect(p.hook).toBeNull();
    expect(p.audio.sfx.map((c) => c.src)).toEqual(["sfx/whoosh.mp3"]);
  });

  it("drops every cue when sound effects are off", () => {
    const quiet = structuredClone(m);
    quiet.request.render.sfx = false;
    expect(buildRenderProps(quiet, opts, []).props.audio.sfx).toEqual([]);
  });

  it("puts the brand's logo at its corner and publishes the logo and brand font from the run directory", () => {
    const branded = structuredClone(m);
    branded.request.render.brand = {
      name: "Acme",
      logo: "brand/logo.svg",
      watermark: { position: "bottom-left", widthPct: 10, opacity: 0.5, marginPct: 3 },
      font: { family: "Acme Sans", file: "brand/Acme.ttf", weight: 700 },
    };
    const b = buildRenderProps(branded, opts, []);
    expect(b.props.brand).toEqual({ logo: "brand/logo.svg", position: "bottom-left", widthPct: 10, opacity: 0.5, marginPct: 3 });
    expect(b.files["brand/logo.svg"]).toBe("/run/brand/logo.svg");
    expect(b.files["brand/Acme.ttf"]).toBe("/run/brand/Acme.ttf");
    expect(b.props.captions.style.font.family).toBe("Acme Sans");
    expect(props.brand).toBeNull();
  });

  it("captions in the preset's look and publishes its font", () => {
    expect(props.captions.style).toEqual(PRESETS.cyberpunk.caption);
    expect(files["Orbitron-Variable.ttf"]).toBe("/fonts/Orbitron-Variable.ttf");
  });
});

describe("buildRenderProps with a script's own sounds (phase 12)", () => {
  const withCues = () => {
    const m = manifest();
    m.request.render = { ...m.request.render, hook: true, sfx: true, sfxGain: 1 };
    m.script!.scenes[1] = { ...m.script!.scenes[1], soundCues: [{ sound: "door", at: "middle" }, { sound: "rain", at: "start" }] };
    return m;
  };

  it("plays a door at the scene's middle and a rain bed under the rest of the scene, both published", () => {
    const m = withCues();
    const { props, files } = buildRenderProps(m, opts, []);
    const sc = props.scenes[1];
    expect(props.audio.sfx).toContainEqual({ src: "sfx/door.mp3", frame: sc.from + Math.floor(sc.frames / 2), gain: 0.8 });
    expect(props.audio.sfx).toContainEqual({ src: "sfx/rain.mp3", frame: sc.from, gain: 0.25, durationFrames: sc.frames, fadeFrames: 15 });
    expect(files["sfx/door.mp3"]).toBe("/sfx/door.mp3");
    expect(files["sfx/rain.mp3"]).toBe("/sfx/rain.mp3");
    expect(RenderProps.safeParse(props).success).toBe(true);
    expect(props.audio.sfx.map((c) => c.frame)).toEqual([...props.audio.sfx.map((c) => c.frame)].sort((a, b) => a - b));
  });

  it("plays none of them when sound effects are off", () => {
    const m = withCues();
    m.request.render.sfx = false;
    expect(buildRenderProps(m, opts, []).props.audio.sfx).toEqual([]);
  });

  it("yields exactly the edit's cues for a script without sounds", () => {
    const m = manifest();
    m.request.render = { ...m.request.render, hook: true, sfx: true, sfxGain: 1 };
    const { props } = buildRenderProps(m, opts, []);
    const edit = sfxCues(props.boundaries, { hook: props.hook !== null, gain: 1 });
    expect(props.audio.sfx.map((c) => [c.frame, c.gain])).toEqual(edit.map((c) => [c.frame, c.gain]));
    expect(props.audio.sfx.every((c) => c.durationFrames === undefined)).toBe(true);
  });

  it("keeps the door on the same second at 60 fps", () => {
    const m = withCues();
    const at = (fps: number) => {
      const { props } = buildRenderProps(m, { ...opts, fps }, []);
      const door = props.audio.sfx.find((c) => c.src === "sfx/door.mp3")!;
      const sc = props.scenes[1];
      return { door: door.frame, mid: sc.from + Math.floor(sc.frames / 2), from: sc.from };
    };
    const a = at(30);
    const b = at(60);
    expect(b.door).toBe(b.mid);
    expect(Math.abs(b.door / 60 - a.door / 30)).toBeLessThan(0.05);
  });

  it("has the cues in the render's input, so a changed cue list renders again", async () => {
    const a = withCues();
    const b = structuredClone(a);
    b.script!.scenes[1].soundCues = [{ sound: "knock", at: "start" }];
    const json = (m: typeof a) => JSON.stringify(buildRenderProps(m, opts, []).props);
    expect(json(a)).not.toBe(json(b));
  });
});
