import { ffmpeg } from "./ffmpeg.js";

/** Sample-accurate audio concat to 48 kHz mono PCM (the narration track starts at frame 0). */
export async function concatAudio(inputs: string[], out: string): Promise<void> {
  const args = inputs.flatMap((p) => ["-i", p]);
  const labels = inputs.map((_, i) => `[${i}:a]`).join("");
  const filter = `${labels}concat=n=${inputs.length}:v=0:a=1[a]`;
  await ffmpeg([...args, "-filter_complex", filter, "-map", "[a]", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
}

/**
 * Loudness pass after the Remotion render: the video stream is copied untouched; the audio is normalised to
 * -14 LUFS and padded/trimmed to exactly `totalSec`, so encoder delay can never shift A/V by more than a frame.
 */
export async function loudnessPass(input: string, out: string, totalSec: number): Promise<void> {
  await ffmpeg([
    "-i", input, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
    "-af", `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad,atrim=end=${totalSec.toFixed(6)}`,
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
  ]);
}
