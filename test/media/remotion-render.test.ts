import { join, resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { countFrames, ffmpeg, probeVideo } from "../../src/media/ffmpeg.js";
import { CaptionStyleName, type RenderProps, Transition } from "../../src/media/remotion/props.js";
import { captionPages, wordsToCaptions } from "../../src/media/remotion/caption-pages.js";
import { renderVideo } from "../../src/media/remotion/render.js";
import { CAPTION_STYLES } from "../../src/media/remotion/styles.js";
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
    audio: { narration: "narration.wav", bgm: null, speech: [] },
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
    const [r45, , b45] = await avgRgb(out, 45); // middle of the window: half and half
    const [r50, , b50] = await avgRgb(out, 50); // after the window: pure blue
    expect(r39).toBeGreaterThan(230);
    expect(b39).toBeLessThan(25);
    expect(r45).toBeGreaterThan(100);
    expect(r45).toBeLessThan(160);
    expect(b45).toBeGreaterThan(100);
    expect(b45).toBeLessThan(160);
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

  it("renders every caption style", async () => {
    const dir = await tempDir();
    await makeImage(join(dir, "black.png"), { width: 192, height: 336, color: "black" });
    await makeAudio(join(dir, "narration.wav"), [{ silence: 1 }]);
    const pages = captionPages(wordsToCaptions([{ text: "hello", start: 0, end: 0.5 }, { text: "world", start: 0.5, end: 1 }], 3));
    for (const name of CaptionStyleName.options) {
      const style = CAPTION_STYLES[name];
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
      expect(r + g + b).toBeGreaterThan(10); // pure black sums to 0
    }
  });
});
