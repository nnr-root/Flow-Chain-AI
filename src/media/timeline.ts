/** Frames per scene from cumulative audio boundaries: total = round(Σd · fps), max offset ½ frame. */
export function sceneFrameCounts(durations: number[], fps: number): number[] {
  let elapsed = 0;
  let prevFrame = 0;
  return durations.map((d) => {
    elapsed += d;
    const frame = Math.round(elapsed * fps);
    const count = frame - prevFrame;
    prevFrame = frame;
    return count;
  });
}

export function audioStarts(durations: number[]): number[] {
  let t = 0;
  return durations.map((d) => {
    const start = t;
    t += d;
    return start;
  });
}

export function requestedSec(audioDuration: number): 5 | 10 {
  return audioDuration <= 5 ? 5 : 10;
}
