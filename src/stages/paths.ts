import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StageContext } from "./types.js";

const n = (scene: number) => String(scene + 1).padStart(2, "0");

/** Run-relative file layout. File names are 1-based to match what humans see in the CLI. */
export const paths = {
  script: "script.json",
  rawAudio: (i: number) => `audio/scene_${n(i)}.raw.mp3`,
  audio: (i: number) => `audio/scene_${n(i)}.wav`,
  /** A speaking scene's sound as its clip carried it, before its silence is trimmed (phase 15 spec §13.2). */
  clipAudio: (i: number) => `audio/scene_${n(i)}.clip.wav`,
  keyframe: (i: number) => `images/keyframe_${n(i)}.png`,
  /** The character portrait every keyframe is conditioned on (RunPod runs with characters). */
  reference: "images/reference.png",
  clip: (i: number) => `clips/clip_${n(i)}.mp4`,
  /** chain.png: first frame of scene i's raw clip. */
  firstFrame: (i: number) => `frames/first_${n(i)}.png`,
  /** chain.png: last frame of scene i's fitted clip (what viewers see last); Mode 2 rows use the keyframe. */
  lastFrame: (i: number) => `frames/last_${n(i)}.png`,
  /** The last frame fitted clip i shows; the chain image of a continuing scene i+1. */
  seam: (i: number) => `frames/seam_${n(i)}.png`,
  /** Clip i upscaled to full HD (phase 8 spec §8). */
  upscaled: (i: number) => `clips/clip_${n(i)}.hd.mp4`,
  /** Clip i interpolated to twice its frame rate (phase 11 spec §4). */
  smoothed: (i: number) => `clips/clip_${n(i)}.60.mp4`,
  fitted: (i: number) => `fitted/scene_${n(i)}.mp4`,
  /** Scene i's sound, levelled (phase 14 spec §3; its own clip's since phase 15 §6). */
  sound: (i: number) => `sound/scene_${n(i)}.wav`,
  /** Scene i's sound as taken out of its clip, before it is levelled. */
  soundRaw: (i: number) => `sound/scene_${n(i)}.raw.wav`,
  captions: "captions.json",
  /** Render working folder: staged public files and the Remotion bundle (recreated per render). */
  renderDir: "render",
  video: "video.mp4",
  narration: "narration.wav",
  final: "final.mp4",
  chain: "chain.png",
} as const;

export const abs = (ctx: StageContext, rel: string): string => join(ctx.dir, rel);

export async function outPath(ctx: StageContext, rel: string): Promise<string> {
  const p = abs(ctx, rel);
  await mkdir(dirname(p), { recursive: true });
  return p;
}
