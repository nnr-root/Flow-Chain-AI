import type { Size } from "../config.js";
import type { Camera } from "../manifest/schema.js";
import { ffmpeg } from "./ffmpeg.js";

// Literal strings: 1.15 - 1 in floating point is 0.1499999…, which would leak into the filter.
const MAX_ZOOM = "1.15";
const ZOOM_DELTA = "0.15";
const CENTER_X = "iw/2-(iw/zoom/2)";
const CENTER_Y = "ih/2-(ih/zoom/2)";

export function zoompanExpr(camera: Camera, frames: number): { z: string; x: string; y: string } {
  const p = `on/${Math.max(frames - 1, 1)}`;
  switch (camera) {
    case "zoom_in":
      return { z: `1+${ZOOM_DELTA}*${p}`, x: CENTER_X, y: CENTER_Y };
    case "zoom_out":
      return { z: `${MAX_ZOOM}-${ZOOM_DELTA}*${p}`, x: CENTER_X, y: CENTER_Y };
    case "pan_left":
      return { z: MAX_ZOOM, x: `(iw-iw/zoom)*(1-${p})`, y: CENTER_Y };
    case "pan_right":
      return { z: MAX_ZOOM, x: `(iw-iw/zoom)*(${p})`, y: CENTER_Y };
    case "pan_up":
      return { z: MAX_ZOOM, x: CENTER_X, y: `(ih-ih/zoom)*(1-${p})` };
    case "pan_down":
      return { z: MAX_ZOOM, x: CENTER_X, y: `(ih-ih/zoom)*(${p})` };
  }
}

/** Crops to the output aspect at 4x resolution first; zoompan on a small source jitters visibly. */
export function kenBurnsFilter(camera: Camera, frames: number, size: Size, fps: number): string {
  const { z, x, y } = zoompanExpr(camera, frames);
  const W = size.width * 4;
  const H = size.height * 4;
  return (
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${size.width}x${size.height}:fps=${fps},format=yuv420p[v]`
  );
}

export async function renderKenBurns(
  image: string,
  out: string,
  camera: Camera,
  frames: number,
  size: Size,
  fps: number,
): Promise<void> {
  await ffmpeg([
    "-i", image, "-filter_complex", kenBurnsFilter(camera, frames, size, fps), "-map", "[v]",
    "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", out,
  ]);
}
