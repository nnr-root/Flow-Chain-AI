import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StageContext } from "./types.js";

const n = (scene: number) => String(scene + 1).padStart(2, "0");

/** Run-relative file layout. File names are 1-based to match what humans see in the CLI. */
export const paths = {
  script: "script.json",
  rawAudio: (i: number) => `audio/scene_${n(i)}.raw.mp3`,
  audio: (i: number) => `audio/scene_${n(i)}.wav`,
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
  fitted: (i: number) => `fitted/scene_${n(i)}.mp4`,
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
