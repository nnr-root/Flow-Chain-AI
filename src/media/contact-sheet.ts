import type { Size } from "../config.js";
import { ffmpeg } from "./ffmpeg.js";

export function cellSize(output: Size, rowHeight = 360): Size {
  return { width: Math.round((rowHeight * output.width) / output.height / 2) * 2, height: rowHeight };
}

/** One row per clip: [first frame | last frame]. Used to eyeball continuity-chain drift. */
export async function contactSheet(rows: Array<{ first: string; last: string }>, out: string, cell: Size): Promise<void> {
  const files = rows.flatMap((r) => [r.first, r.last]);
  const inputs = files.flatMap((f) => ["-i", f]);
  const scaled = files.map(
    (_, i) =>
      `[${i}:v]scale=${cell.width}:${cell.height}:force_original_aspect_ratio=decrease,` +
      `pad=${cell.width}:${cell.height}:(ow-iw)/2:(oh-ih)/2,format=rgb24[c${i}]`,
  );
  const layout = files.map((_, i) => `${(i % 2) * cell.width}_${Math.floor(i / 2) * cell.height}`).join("|");
  const labels = files.map((_, i) => `[c${i}]`).join("");
  const filter = `${scaled.join(";")};${labels}xstack=inputs=${files.length}:layout=${layout}[out]`;
  await ffmpeg([...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", out]);
}
