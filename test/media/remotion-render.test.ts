import { join, resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { countFrames, ffmpeg, probeVideo } from "../../src/media/ffmpeg.js";
import { type CaptionStyle, CaptionStyleName, type RenderProps, Transition } from "../../src/media/remotion/props.js";
import { captionPages, wordsToCaptions } from "../../src/media/remotion/caption-pages.js";
import { renderVideo } from "../../src/media/remotion/render.js";
import { CAPTION_STYLES } from "../../src/media/remotion/styles.js";
import { PRESETS } from "../../src/presets.js";
import { makeAudio, makeImage, tempDir } from "../helpers/media.js";

const FONT = resolve("assets/fonts/Montserrat-ExtraBold.ttf");

/** Average RGB of one frame (optionally of an ffmpeg `crop` region), scaled down to a single pixel. */
async function avgRgb(video: string, frame: number, crop?: string): Promise<[number, number, number]> {
  const region = crop ? `,crop=${crop}` : "";
  const r = await execa("ffmpeg", [
    "-v", "error", "-i", video, "-vf", `select=eq(n\\,${frame})${region},scale=1:1`, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { encoding: "buffer" });
  const b = r.stdout as Uint8Array;
  return [b[0], b[1], b[2]];
}

/** Mean volume (dB) of an audio window, via ffmpeg volumedetect. */
async function meanVolume(file: string, start: number, duration: number): Promise<number> {
  const log = await ffmpeg(["-ss", String(start), "-t", String(duration), "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
    logLevel: "info",
  });
  const m = /mean_volume: (-?[\d.]+) dB/.exec(log);
  if (!m) throw new Error("no mean_volume in ffmpeg output");
  return Number(m[1]);
}

function baseProps(overrides: Partial<RenderProps>): RenderProps {
  return {
    fps: 30,
    width: 180,
    height: 320,
    totalFrames: 90,
    scenes: [],
    boundaries: [],
    captions: { style: CAPTION_STYLES.hormozi, bottomPct: 30, pages: [] },
    audio: { narration: "narration.wav", bgm: null, speech: [], sfx: [] },
    ...overrides,
  };
}

describe("Remotion composition (real Chrome)", () => {
  it("cross-fades a cut over a 10-frame window centred on the boundary, without moving it", async () => {
    const dir = await tempDir();
    await makeImage(join(dir, "red.png"), { width: 192, height: 336, color: "red" });
    await makeImage(join(dir, "blue.png"), { width: 192, height: 336, color: "blue" });
    await makeAudio(join(dir, "narration.wav"), [{ silence: 3 }]);
    const out = join(dir, "video.mp4");
    await renderVideo({
      props: baseProps({
        scenes: [
          { kind: "still", src: "red.png", camera: "zoom_in", from: 0, frames: 45 },
          { kind: "still", src: "blue.png", camera: "zoom_out", from: 45, frames: 45 },
        ],
        boundaries: [{ frame: 45, kind: "cut", transition: "fade", halfWindow: 5 }],
      }),
      files: {
        "red.png": join(dir, "red.png"),
        "blue.png": join(dir, "blue.png"),
        "narration.wav": join(dir, "narration.wav"),
        "Montserrat-ExtraBold.ttf": FONT,
      },
      workDir: join(dir, "render"),
      out,
    });

    expect(await countFrames(out)).toBe(90);
    expect(await probeVideo(out)).toEqual({ width: 180, height: 320, fps: 30 });
    const [r39, , b39] = await avgRgb(out, 39); // before the window: pure red
    const [r45, , b45] = await avgRgb(out, 45); // the window's 6th of 10 frames: 60 % blue
    const [r49, , b49] = await avgRgb(out, 49); // the window's last frame: fully blue, no jump after it
    const [r50, , b50] = await avgRgb(out, 50); // after the window: pure blue
    expect(r39).toBeGreaterThan(230);
    expect(b39).toBeLessThan(25);
    expect(r45).toBeGreaterThan(75);
    expect(r45).toBeLessThan(130);
    expect(b45).toBeGreaterThan(125);
    expect(b45).toBeLessThan(180);
    expect(r49).toBeLessThan(25);
    expect(b49).toBeGreaterThan(230);
    expect(r50).toBeLessThan(25);
    expect(b50).toBeGreaterThan(230);
  });

  it("ducks the BGM under speech and restores it between speech", async () => {
    const dir = await tempDir();
    await makeImage(join(dir, "still.png"), { width: 192, height: 336 });
    await makeAudio(join(dir, "narration.wav"), [{ silence: 3 }]); // silent: only the BGM is measured
    await makeAudio(join(dir, "bgm.wav"), [{ tone: 3, freq: 220 }]);
    const out = join(dir, "video.mp4");
    await renderVideo({
      props: baseProps({
        scenes: [{ kind: "still", src: "still.png", camera: "zoom_in", from: 0, frames: 90 }],
        audio: {
          narration: "narration.wav",
          bgm: { src: "bgm.wav", gain: 1, duckTo: 0.18, rampFrames: 6, fadeOutFrames: 1 },
          speech: [
            { from: 0, to: 30 },
            { from: 60, to: 90 },
          ],
          sfx: [],
        },
      }),
      files: {
        "still.png": join(dir, "still.png"),
        "narration.wav": join(dir, "narration.wav"),
        "bgm.wav": join(dir, "bgm.wav"),
        "Montserrat-ExtraBold.ttf": FONT,
      },
      workDir: join(dir, "render"),
      out,
    });

    const ducked = await meanVolume(out, 0.2, 0.6);
    const open = await meanVolume(out, 1.35, 0.3); // clear of the 6-frame ramps on both sides
    expect(open - ducked).toBeGreaterThan(10); // 0.18 ≈ -15 dB
  });

  it("evaluates the BGM volume curve on the video's frames when the BGM file loops", async () => {
    const dir = await tempDir();
    await makeImage(join(dir, "still.png"), { width: 192, height: 336 });
    await makeAudio(join(dir, "narration.wav"), [{ silence: 3 }]); // silent: only the BGM is measured
    await makeAudio(join(dir, "bgm.wav"), [{ tone: 1, freq: 220 }]); // 1 s, looped three times under 3 s of video
    const out = join(dir, "video.mp4");
    await renderVideo({
      props: baseProps({
        scenes: [{ kind: "still", src: "still.png", camera: "zoom_in", from: 0, frames: 90 }],
        audio: {
          narration: "narration.wav",
          bgm: { src: "bgm.wav", gain: 1, duckTo: 0.18, rampFrames: 6, fadeOutFrames: 30 },
          speech: [{ from: 0, to: 30 }], // only the first second is speech
          sfx: [],
        },
      }),
      files: {
        "still.png": join(dir, "still.png"),
        "narration.wav": join(dir, "narration.wav"),
        "bgm.wav": join(dir, "bgm.wav"),
        "Montserrat-ExtraBold.ttf": FONT,
      },
      workDir: join(dir, "render"),
      out,
    });

    const ducked = await meanVolume(out, 0.2, 0.6); // inside the speech frames
    const open = await meanVolume(out, 1.4, 0.5); // after speech, before the fade-out starts at 2 s
    const tail = await meanVolume(out, 2.8, 0.2); // the fade-out has nearly reached silence
    // without "extend" the curve restarts at frame 0 on every loop: every second is ducked and the fade never arrives
    expect(open - ducked).toBeGreaterThan(10);
    expect(open - tail).toBeGreaterThan(10);
  });

  it("plays a sound-effect cue at its frame", async () => {
    const dir = await tempDir();
    await makeImage(join(dir, "still.png"), { width: 192, height: 336 });
    await makeAudio(join(dir, "narration.wav"), [{ silence: 3 }]); // silent: only the sound effect is measured
    const out = join(dir, "video.mp4");
    await renderVideo({
      props: baseProps({
        scenes: [{ kind: "still", src: "still.png", camera: "zoom_in", from: 0, frames: 90 }],
        audio: { narration: "narration.wav", bgm: null, speech: [], sfx: [{ src: "sfx/whoosh.mp3", frame: 37, gain: 0.8 }] },
      }),
      files: {
        "still.png": join(dir, "still.png"),
        "narration.wav": join(dir, "narration.wav"),
        "sfx/whoosh.mp3": resolve("assets/sfx/whoosh.mp3"),
        "Montserrat-ExtraBold.ttf": FONT,
      },
      workDir: join(dir, "render"),
      out,
    });

    const before = await meanVolume(out, 0.3, 0.6); // nothing plays yet
    const around = await meanVolume(out, 37 / 30 + 0.1, 0.3); // the whoosh's loud middle (peak 0.25 s after frame 37)
    expect(around - before).toBeGreaterThan(30);
  });

  it("renders every transition, each only inside its own window", async () => {
    const dir = await tempDir();
    const colors = ["red", "lime", "blue", "yellow", "cyan", "magenta", "white"];
    const files: Record<string, string> = { "Montserrat-ExtraBold.ttf": FONT, "narration.wav": join(dir, "narration.wav") };
    for (const c of colors) {
      await makeImage(join(dir, `${c}.png`), { width: 192, height: 336, color: c });
      files[`${c}.png`] = join(dir, `${c}.png`);
    }
    await makeAudio(join(dir, "narration.wav"), [{ silence: 140 / 30 }]);
    const scenes = colors.map((c, i) => ({ kind: "still" as const, src: `${c}.png`, camera: "zoom_in" as const, from: i * 20, frames: 20 }));
    const boundaries = Transition.options.map((t, i) => ({
      frame: (i + 1) * 20,
      kind: "cut" as const,
      transition: t,
      halfWindow: t === "cut" ? 0 : t === "glitch" ? 3 : 5,
    }));
    const out = join(dir, "video.mp4");
    await renderVideo({ props: baseProps({ totalFrames: 140, scenes, boundaries }), files, workDir: join(dir, "render"), out });
    expect(await countFrames(out)).toBe(140);
    // the middle of every scene is untouched by the windows around it: the scene's own colour
    const [r10, g10, b10] = await avgRgb(out, 10); // red
    const [r70, g70, b70] = await avgRgb(out, 70); // yellow
    expect(r10).toBeGreaterThan(230);
    expect(g10 + b10).toBeLessThan(40);
    expect(r70 + g70).toBeGreaterThan(460);
    expect(b70).toBeLessThan(25);
  });


  /** Renders "hello world" in `style` on a black frame; returns the brightness of the caption band at frame 5. */
  async function captionBand(dir: string, name: string, style: CaptionStyle): Promise<number> {
    const pages = captionPages(wordsToCaptions([{ text: "hello", start: 0, end: 0.5 }, { text: "world", start: 0.5, end: 1 }], 3));
    const out = join(dir, `${name}.mp4`);
    await renderVideo({
      props: baseProps({
        totalFrames: 30,
        scenes: [{ kind: "still", src: "black.png", camera: "zoom_in", from: 0, frames: 30 }],
        captions: { style, bottomPct: 30, pages },
      }),
      files: {
        "black.png": join(dir, "black.png"),
        "narration.wav": join(dir, "narration.wav"),
        [style.font.file]: resolve("assets/fonts", style.font.file),
      },
      workDir: join(dir, `render-${name}`),
      out,
    });
    // the caption band (bottom edge 30 % above the bottom of the frame) on an otherwise black frame
    const [r, g, b] = await avgRgb(out, 5, "iw:ih*0.12:0:ih*0.6");
    return r + g + b;
  }

  async function blackScene(): Promise<string> {
    const dir = await tempDir();
    await makeImage(join(dir, "black.png"), { width: 192, height: 336, color: "black" });
    await makeAudio(join(dir, "narration.wav"), [{ silence: 1 }]);
    return dir;
  }

  it("renders every caption style and every preset's caption look", async () => {
    const dir = await blackScene();
    const looks: Array<[string, CaptionStyle]> = [
      ...CaptionStyleName.options.map((n): [string, CaptionStyle] => [n, CAPTION_STYLES[n]]),
      ...Object.values(PRESETS).map((p): [string, CaptionStyle] => [`preset-${p.name}`, p.caption]),
    ];
    for (const [name, style] of looks) {
      expect(await captionBand(dir, name, style), name).toBeGreaterThan(10); // pure black sums to 0
    }
  });

  it("renders the variable fonts at the requested weight", async () => {
    const dir = await blackScene();
    for (const font of [PRESETS.cinematic_history.caption.font, PRESETS.cyberpunk.caption.font]) {
      const plain = (weight: number): CaptionStyle => ({
        ...CAPTION_STYLES.minimalist,
        font: { ...font, weight },
        inactiveOpacity: 1,
        shadow: null,
      });
      const regular = await captionBand(dir, `${font.family}-400`, plain(400));
      const bold = await captionBand(dir, `${font.family}-700`, plain(700));
      expect(bold, font.family).toBeGreaterThan(regular * 1.15); // thicker strokes light more of the band
    }
  });
});
