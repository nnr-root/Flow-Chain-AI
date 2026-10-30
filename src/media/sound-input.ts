/*
 * The small video the Foley model hears a scene from (plan ruling 2): 480 on its short side, 24 fps, no sound. A Full HD
 * fitted scene would pass the 9 MB a request may carry; the model gains nothing from more pixels.
 */

export const SOUND_INPUT_SHORT = 480;
export const SOUND_INPUT_FPS = 24;
const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p"];

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The input's size for a picture of `width` x `height`: its short side 480, its long side in proportion, both even. */
export function soundInputSize(width: number, height: number): { width: number; height: number } {
  return width <= height
    ? { width: SOUND_INPUT_SHORT, height: even((height * SOUND_INPUT_SHORT) / width) }
    : { width: even((width * SOUND_INPUT_SHORT) / height), height: SOUND_INPUT_SHORT };
}

/** A moving scene: its fitted video (what is seen, at the scene's length), cut to the sound's seconds. */
export function movingInputArgs(fitted: string, out: string, o: { seconds: number; width: number; height: number }): string[] {
  return ["-i", fitted, "-t", String(o.seconds), "-vf", `fps=${SOUND_INPUT_FPS},scale=${o.width}:${o.height},setsar=1`, "-an", ...ENCODE, out];
}

/**
 * A still scene: a slow zoom over its picture for the sound's seconds, so the model sees a scene that moves as a
 * still does in the render. One input frame, `d` frames out of it.
 */
export function stillInputArgs(picture: string, out: string, o: { seconds: number; width: number; height: number }): string[] {
  const frames = Math.max(1, Math.round(o.seconds * SOUND_INPUT_FPS));
  const zoom = `zoompan=z='min(zoom+0.0015,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${o.width}x${o.height}:fps=${SOUND_INPUT_FPS}`;
  return ["-i", picture, "-vf", `scale=${o.width * 2}:${o.height * 2},${zoom},setsar=1`, "-frames:v", String(frames), "-an", ...ENCODE, out];
}
