/**
 * Regenerates the bundled sound effects in assets/sfx (npm run make:sfx). Every sound is a pure formula of time
 * (aevalsrc; its random() is a fixed pseudo-random sequence), so the result never depends on a seed or a download.
 * The MP3s are committed: renders never synthesize.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ffmpeg } from "../src/media/ffmpeg.js";

const RATE = 44100;

type Recipe = { file: string; seconds: number; expr: string; filters?: string };

export const RECIPES: Recipe[] = [
  {
    // a low sine sweep 110 → 40 Hz with a fast attack and exponential decay, plus a short noise burst
    file: "impact_boom.mp3",
    seconds: 1.2,
    expr:
      "min(1,t/0.004)*(0.75*sin(2*PI*(40*t+70*0.25*(1-exp(-t/0.25))))*exp(-3.5*t)" +
      "+0.35*(2*random(0)-1)*exp(-18*t))",
    filters: "lowpass=f=3000",
  },
  {
    // noise through a low band that fades out while a high band fades in (an upward sweep), loudest at 0.25 s
    file: "whoosh.mp3",
    seconds: 0.5,
    expr: "(2*random(0)-1)*pow(sin(PI*t/0.5),2)",
    filters:
      "asplit=2[lo][hi];[lo]bandpass=f=700:width_type=h:w=600,volume='1-t/0.5':eval=frame[l];" +
      "[hi]bandpass=f=2600:width_type=h:w=1800,volume='t/0.5':eval=frame[h];[l][h]amix=inputs=2:normalize=0,volume=2",
  },
  {
    // a 900 → 500 Hz blip
    file: "pop.mp3",
    seconds: 0.08,
    expr: "min(1,t/0.003)*0.9*sin(2*PI*(500*t+400*0.02*(1-exp(-t/0.02))))*exp(-40*t)",
  },
];

export async function synthesizeSfx(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const r of RECIPES) {
    const source = `aevalsrc=exprs='${r.expr}':s=${RATE}:d=${r.seconds}`;
    const graph = r.filters ? `${source},${r.filters},aformat=channel_layouts=stereo` : `${source},aformat=channel_layouts=stereo`;
    await ffmpeg(["-filter_complex", graph, "-ar", String(RATE), "-c:a", "libmp3lame", "-b:a", "192k", join(outDir, r.file)]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = resolve(import.meta.dirname, "../assets/sfx");
  await synthesizeSfx(out);
  console.log(`wrote ${RECIPES.map((r) => r.file).join(", ")} to ${out}`);
}
