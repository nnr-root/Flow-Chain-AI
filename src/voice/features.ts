/*
 * Rough measures of what a voice sounds like (phase 7 spec §16), to tell whether two designed voices are one
 * voice in two moods, and which of several takes of a voice in another language is nearest to it. Not a speaker
 * model: the pitch it is spoken at, and the shape of its spectrum, which carries most of what makes a voice
 * itself. Pure arithmetic on 16 kHz mono samples.
 */
export type VoiceFeatures = { f0: number; envelope: number[] };

const RATE = 16_000;
const WIN = 640;
const HOP = 160;
const BANDS = 20;

/** The magnitude spectrum of one frame (a plain DFT over the bins wanted; a few thousand frames a clip). */
function spectrum(frame: Float64Array, bins: number): Float64Array {
  const out = new Float64Array(bins);
  const n = frame.length;
  for (let k = 1; k < bins; k++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let t = 0; t < n; t += 2) {
      re += frame[t] * Math.cos(w * t);
      im -= frame[t] * Math.sin(w * t);
    }
    out[k] = Math.hypot(re, im);
  }
  return out;
}

export function voiceFeatures(samples: Float32Array): VoiceFeatures {
  const hann = Float64Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1)));
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => 80 * (7000 / 80) ** (i / BANDS));
  const binHz = RATE / WIN;
  const bins = Math.ceil(7000 / binHz) + 1;
  const f0s: number[] = [];
  const env = new Float64Array(BANDS);
  let frames = 0;
  for (let i = 0; i + WIN <= samples.length; i += HOP * 4) {
    const fr = new Float64Array(WIN);
    let energy = 0;
    for (let t = 0; t < WIN; t++) {
      fr[t] = samples[i + t] * hann[t];
      energy += fr[t] * fr[t];
    }
    if (Math.sqrt(energy / WIN) < 0.01) continue;
    frames++;
    const spec = spectrum(fr, bins);
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      let count = 0;
      for (let k = Math.floor(edges[b] / binHz); k < Math.min(bins, Math.ceil(edges[b + 1] / binHz)); k++) {
        sum += spec[k];
        count++;
      }
      env[b] += Math.log((count ? sum / count : 0) + 1e-9);
    }
    // the pitch: the strongest repeat between 60 and 400 Hz, when it is clear enough to be voiced
    let best = 0;
    let lag = 0;
    let zero = 0;
    for (let t = 0; t < WIN; t++) zero += fr[t] * fr[t];
    for (let k = Math.floor(RATE / 400); k <= Math.floor(RATE / 60); k++) {
      let c = 0;
      for (let t = 0; t + k < WIN; t++) c += fr[t] * fr[t + k];
      if (c > best) {
        best = c;
        lag = k;
      }
    }
    if (lag && best > 0.3 * zero) f0s.push(RATE / lag);
  }
  const mean = frames ? env.reduce((a, b) => a + b, 0) / BANDS / frames : 0;
  f0s.sort((a, b) => a - b);
  return { f0: f0s.length ? f0s[Math.floor(f0s.length / 2)] : 0, envelope: Array.from(env, (v) => (frames ? v / frames - mean : 0)) };
}

/**
 * How far apart two voices are: the spectrum's shape, and the pitch in octaves (a voice an octave apart is far,
 * whatever its spectrum). Two voices nearer than `TOO_ALIKE` are taken to be one voice.
 */
export function voiceDistance(a: VoiceFeatures, b: VoiceFeatures): number {
  const env = Math.sqrt(a.envelope.reduce((s, v, i) => s + (v - b.envelope[i]) ** 2, 0));
  const pitch = a.f0 > 0 && b.f0 > 0 ? Math.abs(Math.log2(a.f0 / b.f0)) : 0;
  return env + 4 * pitch;
}
export const TOO_ALIKE = 1.6;

/**
 * Whether a voice's pitch is that of the sex it was described as: a man below 180 Hz, a woman above 165 (a man
 * speaking excitedly rises, a woman speaking low falls, and the two overlap a little). A take outside it is not
 * kept: one "young man" came out at 250 Hz and one Turkish "deep bass man" at 280 (phase 7 spec §16).
 */
export const pitchFits = (f: VoiceFeatures, sex: "m" | "f"): boolean => (sex === "m" ? f.f0 > 0 && f.f0 < 180 : f.f0 >= 165);
