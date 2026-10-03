import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpeg } from "../../src/media/ffmpeg.js";

export async function tempDir(prefix = "flowchain-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export type AudioPart = { tone: number; freq?: number } | { silence: number };

/** 48 kHz mono audio made of tones and silences; codec chosen by extension (.wav / .mp3). */
export async function makeAudio(path: string, parts: AudioPart[]): Promise<void> {
  const inputs = parts.flatMap((p) =>
    "tone" in p
      ? ["-f", "lavfi", "-i", `sine=f=${p.freq ?? 440}:d=${p.tone}:sample_rate=48000`]
      : ["-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono:d=${p.silence}`],
  );
  const labels = parts.map((_, i) => `[${i}:a]`).join("");
  const filter = `${labels}concat=n=${parts.length}:v=0:a=1,aformat=channel_layouts=mono[a]`;
  await ffmpeg([...inputs, "-filter_complex", filter, "-map", "[a]", path]);
}

export type VideoOptions = {
  seconds?: number;
  frames?: number;
  fps?: number;
  width?: number;
  height?: number;
  /** Rotates hues so different calls produce visibly different (and differently hashed) videos. */
  hue?: number;
  /**
   * Instead of testsrc2: every frame is one flat grey level that changes from frame to frame, shifted by
   * this offset. Flat frames survive x264 exactly, so "is this the same frame?" can be checked with frameDiff 0.
   */
  flat?: number;
};

export async function makeVideo(path: string, o: VideoOptions = {}): Promise<void> {
  const fps = o.fps ?? 30;
  const width = o.width ?? 320;
  const height = o.height ?? 240;
  const frames = o.frames ?? Math.round((o.seconds ?? 1) * fps);
  const vf = o.hue === undefined ? "format=yuv420p" : `hue=h=${o.hue},format=yuv420p`;
  const source =
    o.flat === undefined
      ? `testsrc2=s=${width}x${height}:r=${fps}`
      : `color=black:s=${width}x${height}:r=${fps},geq=lum='16+mod(N*37+${o.flat}\\,200)':cb=128:cr=128`;
  await ffmpeg([
    "-f", "lavfi", "-i", source,
    "-vf", vf, "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "ultrafast", path,
  ]);
}

export async function makeImage(path: string, o: { width: number; height: number; color?: string }): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-i", `color=c=${o.color ?? "0x3366aa"}:s=${o.width}x${o.height}`, "-frames:v", "1", path]);
}

/** Mean luma of |a − b|; 0 means pixel-identical. Both images must have the same size. */
export async function frameDiff(a: string, b: string): Promise<number> {
  const log = await ffmpeg(
    ["-i", a, "-i", b, "-filter_complex",
      "[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
      "-f", "null", "-"],
    { logLevel: "info" },
  );
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(log);
  if (!m) throw new Error("frameDiff: no YAVG in ffmpeg output");
  return Number(m[1]);
}
