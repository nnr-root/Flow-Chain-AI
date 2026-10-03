import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ffmpeg } from "./ffmpeg.js";

/** Stream-copy concat; all inputs come from the fit stage with identical encoder settings. */
export async function concatVideos(inputs: string[], out: string): Promise<void> {
  const list = `${out}.txt`;
  await writeFile(list, inputs.map((p) => `file '${resolve(p).replace(/'/g, "'\\''")}'`).join("\n"));
  try {
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
  } finally {
    await rm(list, { force: true });
  }
}

/** Sample-accurate audio concat to 48 kHz mono PCM. */
export async function concatAudio(inputs: string[], out: string): Promise<void> {
  const args = inputs.flatMap((p) => ["-i", p]);
  const labels = inputs.map((_, i) => `[${i}:a]`).join("");
  const filter = `${labels}concat=n=${inputs.length}:v=0:a=1[a]`;
  await ffmpeg([...args, "-filter_complex", filter, "-map", "[a]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
}

/** ffmpeg 8 cannot use a path containing a single quote or a colon inside a quoted filter argument. */
export function quoteFilterPath(p: string): string {
  if (p.includes("'")) throw new Error(`path cannot be used in an ffmpeg filter because it contains a quote: ${p}`);
  if (p.includes(":")) throw new Error(`path cannot be used in an ffmpeg filter because it contains a colon: ${p}`);
  return `'${p}'`;
}

export function finalizeFilter(o: { captions: string; fontsDir: string; hasBgm: boolean; totalSec: number }): string {
  const video = `[0:v]ass=${quoteFilterPath(o.captions)}:fontsdir=${quoteFilterPath(o.fontsDir)}[v]`;
  const tail = `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad,atrim=end=${o.totalSec.toFixed(6)}[a]`;
  const stereo = "aformat=sample_rates=48000:channel_layouts=stereo";
  if (!o.hasBgm) return `${video};[1:a]${stereo},${tail}`;
  return [
    video,
    `[1:a]${stereo},asplit=2[n1][n2]`,
    `[2:a]${stereo},volume=0.35[b]`,
    "[b][n1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[d]",
    `[n2][d]amix=inputs=2:duration=first:normalize=0,${tail}`,
  ].join(";");
}

export type FinalizeOptions = {
  video: string;
  narration: string;
  captions: string;
  fontsDir: string;
  bgm?: string;
  totalFrames: number;
  fps: number;
  out: string;
};

/** Video length is pinned with -frames:v and audio with apad+atrim, so neither relies on -shortest. */
export async function finalize(o: FinalizeOptions): Promise<void> {
  const inputs = ["-i", o.video, "-i", o.narration, ...(o.bgm ? ["-stream_loop", "-1", "-i", o.bgm] : [])];
  const filter = finalizeFilter({
    captions: o.captions,
    fontsDir: o.fontsDir,
    hasBgm: Boolean(o.bgm),
    totalSec: o.totalFrames / o.fps,
  });
  await ffmpeg([
    ...inputs, "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
    "-frames:v", String(o.totalFrames),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(o.fps),
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", o.out,
  ]);
}
