import { execa } from "execa";

export class FfmpegError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`ffmpeg failed: ffmpeg ${args.join(" ")}\n${stderr.split("\n").slice(-15).join("\n")}`);
  }
}

/** Runs ffmpeg and returns its stderr (where filters such as silencedetect report). */
export async function ffmpeg(args: string[], opts: { logLevel?: "error" | "info" } = {}): Promise<string> {
  const full = ["-hide_banner", "-nostdin", "-nostats", "-y", "-v", opts.logLevel ?? "error", ...args];
  const r = await execa("ffmpeg", full, { reject: false, maxBuffer: 64 * 1024 * 1024 });
  if (r.exitCode !== 0) throw new FfmpegError(full, String(r.stderr));
  return String(r.stderr);
}

async function ffprobe(args: string[]): Promise<string> {
  const r = await execa("ffprobe", ["-v", "error", ...args], { reject: false });
  if (r.exitCode !== 0) throw new Error(`ffprobe failed: ${String(r.stderr)}`);
  return String(r.stdout).trim();
}

export async function probeDuration(path: string): Promise<number> {
  const d = Number.parseFloat(await ffprobe(["-show_entries", "format=duration", "-of", "csv=p=0", path]));
  if (!Number.isFinite(d)) throw new Error(`could not read duration of ${path}`);
  return d;
}

export async function countFrames(path: string): Promise<number> {
  const out = await ffprobe([
    "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path,
  ]);
  return Number.parseInt(out, 10);
}

export async function probeVideo(path: string): Promise<{ width: number; height: number; fps: number }> {
  const out = await ffprobe([
    "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", path,
  ]);
  const [w, h, rate] = out.split(",");
  const [num, den] = rate.split("/").map(Number);
  return { width: Number(w), height: Number(h), fps: num / (den || 1) };
}

export async function streamDuration(path: string, kind: "v" | "a"): Promise<number> {
  const out = await ffprobe(["-select_streams", `${kind}:0`, "-show_entries", "stream=duration", "-of", "csv=p=0", path]);
  return Number.parseFloat(out);
}
