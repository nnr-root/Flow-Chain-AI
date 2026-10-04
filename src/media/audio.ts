import { rename, rm } from "node:fs/promises";
import { ffmpeg } from "./ffmpeg.js";

/** Sample-accurate audio concat to 48 kHz mono PCM (the narration track starts at frame 0). */
export async function concatAudio(inputs: string[], out: string): Promise<void> {
  const args = inputs.flatMap((p) => ["-i", p]);
  const labels = inputs.map((_, i) => `[${i}:a]`).join("");
  const filter = `${labels}concat=n=${inputs.length}:v=0:a=1[a]`;
  await ffmpeg([...args, "-filter_complex", filter, "-map", "[a]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
}

/**
 * Everything the loudness pass applies between its input and its output. loudnessPass runs exactly these, and the
 * render cache key includes them, so changing the normalisation or the encoder re-renders (they cannot drift apart).
 */
export function loudnessPassArgs(totalSec: number): string[] {
  return [
    "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
    "-af", `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad,atrim=end=${totalSec.toFixed(6)}`,
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
  ];
}

/**
 * Loudness pass after the Remotion render: the video stream is copied untouched; the audio is normalised to
 * -14 LUFS and padded/trimmed to exactly `totalSec`, so encoder delay can never shift A/V by more than a frame.
 * The result is written next to `out` and renamed over it only on success, so a failed pass leaves an existing `out` alone.
 */
export async function loudnessPass(input: string, out: string, totalSec: number): Promise<void> {
  const tmp = `${out}.tmp.mp4`; // keeps the .mp4 extension so ffmpeg picks the muxer
  try {
    await ffmpeg(["-i", input, ...loudnessPassArgs(totalSec), tmp]);
    await rename(tmp, out);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
