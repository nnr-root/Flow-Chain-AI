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
  {
    // a dull thud with a short scuff
    file: "footstep.mp3",
    seconds: 0.25,
    expr: "min(1,t/0.003)*(0.6*sin(2*PI*90*t)*exp(-25*t)+0.4*(2*random(0)-1)*exp(-60*t))",
    filters: "lowpass=f=1500",
  },
  {
    // a low thump with a short noise slam
    file: "door.mp3",
    seconds: 0.6,
    expr: "min(1,t/0.004)*(0.8*sin(2*PI*70*t)*exp(-9*t)+0.5*(2*random(0)-1)*exp(-30*t))",
    filters: "lowpass=f=1200",
  },
  {
    // two wooden knocks 0.18 s apart
    file: "knock.mp3",
    seconds: 0.4,
    expr: "0.8*sin(2*PI*160*t)*min(1,t/0.002)*(exp(-45*t)+gte(t,0.18)*exp(-45*max(0,t-0.18)))",
  },
  {
    // high ringing partials over a crack of noise
    file: "glass.mp3",
    seconds: 0.8,
    expr: "min(1,t/0.002)*0.3*(sin(2*PI*2400*t)+sin(2*PI*3100*t)+sin(2*PI*4200*t))*exp(-9*t)+0.3*(2*random(0)-1)*exp(-80*t)",
  },
  {
    // one 880 Hz tone
    file: "beep.mp3",
    seconds: 0.3,
    expr: "0.5*sin(2*PI*880*t)*min(1,t/0.005)*min(1,(0.3-t)/0.01)",
  },
  {
    // a dry tick
    file: "clock.mp3",
    seconds: 0.1,
    expr: "(2*random(0)-1)*exp(-120*t)",
    filters: "highpass=f=2000",
  },
  {
    // two low thumps
    file: "heartbeat.mp3",
    seconds: 0.9,
    expr: "0.9*sin(2*PI*55*t)*(exp(-14*t)+0.7*gte(t,0.28)*exp(-14*max(0,t-0.28)))",
    filters: "lowpass=f=200,volume=1.4",
  },
  {
    // a burst of band-limited noise
    file: "splash.mp3",
    seconds: 0.9,
    expr: "(2*random(0)-1)*exp(-5*t)*min(1,t/0.01)",
    filters: "highpass=f=400,lowpass=f=6000",
  },
  {
    // a low rumble that swells and dies
    file: "thunder.mp3",
    seconds: 1.9,
    expr: "(2*random(0)-1)*exp(-1.6*t)*min(1,t/0.25)",
    filters: "lowpass=f=220,volume=4",
  },
  {
    // beds: a texture that lasts a scene, faded 30 ms at both ends against a click
    file: "rain.mp3",
    seconds: 4,
    expr: "(2*random(0)-1)*(0.7+0.3*sin(2*PI*0.5*t))",
    filters: "highpass=f=1500,lowpass=f=9000,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03",
  },
  {
    file: "wind.mp3",
    seconds: 4,
    expr: "(2*random(0)-1)*(0.6+0.4*sin(2*PI*0.5*t))",
    filters: "bandpass=f=400:width_type=h:w=500,volume=3,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03",
  },
  {
    file: "crowd.mp3",
    seconds: 4,
    expr: "(2*random(0)-1)*(0.6+0.2*sin(2*PI*1.25*t)+0.2*sin(2*PI*0.75*t))",
    filters: "bandpass=f=450:width_type=h:w=800,volume=3,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03",
  },
  {
    // whole cycles in 4 s, so the loop has no seam
    file: "engine.mp3",
    seconds: 4,
    expr: "0.5*sin(2*PI*55*t)+0.3*sin(2*PI*110*t)+0.2*sin(2*PI*165*t)+0.1*(2*random(0)-1)",
    filters: "lowpass=f=600,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03",
  },
  {
    // noise with random crackles
    file: "fire.mp3",
    seconds: 4,
    expr: "(2*random(0)-1)*(0.15+0.85*pow(random(1),12))",
    filters: "highpass=f=800,volume=1.4,afade=t=in:d=0.03,afade=t=out:st=3.97:d=0.03",
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
