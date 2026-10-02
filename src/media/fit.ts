import type { Size } from "../config.js";
import { ffmpeg } from "./ffmpeg.js";

export const MAX_SLOW = 1.25 as const;

export type FitPlan =
  | { kind: "trim" }
  | { kind: "slow"; factor: number }
  | { kind: "slow+freeze"; factor: typeof MAX_SLOW; freezeSec: number };

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function planFit(clipDur: number, targetDur: number): FitPlan {
  if (clipDur >= targetDur) return { kind: "trim" };
  const ratio = targetDur / clipDur;
  if (ratio <= MAX_SLOW) return { kind: "slow", factor: r4(ratio) };
  return { kind: "slow+freeze", factor: MAX_SLOW, freezeSec: r4(targetDur - clipDur * MAX_SLOW) };
}

/** The trailing tpad guarantees enough frames after fps conversion; -frames:v cuts to the exact count. */
export function fitFilter(plan: FitPlan, size: Size, fps: number): string {
  const parts: string[] = [];
  if (plan.kind !== "trim") parts.push(`setpts=${plan.factor}*PTS`);
  parts.push(
    `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase`,
    `crop=${size.width}:${size.height}`,
    `fps=${fps}`,
    "format=yuv420p",
  );
  const pad = plan.kind === "slow+freeze" ? plan.freezeSec + 0.5 : 0.5;
  parts.push(`tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`);
  return parts.join(",");
}

export async function applyFit(
  input: string,
  output: string,
  plan: FitPlan,
  frames: number,
  size: Size,
  fps: number,
): Promise<void> {
  await ffmpeg([
    "-i", input, "-vf", fitFilter(plan, size, fps), "-frames:v", String(frames), "-an",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), output,
  ]);
}
