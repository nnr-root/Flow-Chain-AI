import type { Size } from "../config.js";
import type { Manifest } from "../manifest/schema.js";
import { requireScript } from "../stages/require.js";

/** Published paths of a draft's generated stand-ins; their "source file" in the files map is `virtual:<what>`. */
export const DRAFT_FILES = {
  scene: (i: number) => `draft/scene_${String(i + 1).padStart(2, "0")}.svg`,
  silence: "draft/silence.wav",
} as const;
export const VIRTUAL = "virtual:";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word wrap for a fixed-width estimate (SVG text does not wrap by itself). */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (line && line.length + 1 + word.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1].slice(0, Math.max(1, maxChars - 1))}…`];
}

/** The picture a draft shows for scene i: what will be bought there, in words. */
export function draftSceneSvg(m: Manifest, i: number, size: Size): string {
  const scene = requireScript(m).scenes[i];
  const { width: w, height: h } = size;
  const unit = Math.min(w, h) / 100;
  const mode = m.scenes[i].mode === 1 ? "clip" : "still";
  const tags = [`scene ${i + 1} of ${m.scenes.length}`, scene.shot, mode, scene.actionLevel ? `${scene.actionLevel} action` : null]
    .filter(Boolean)
    .join("  ·  ");
  // hue walks around the wheel so neighbouring scenes are told apart at a glance
  const hue = Math.round((i * 360) / Math.max(1, m.scenes.length) + 210) % 360;
  // The card's words stay in the top third: the hook title sits around the middle and captions in the lower third.
  const font = unit * 3.6;
  const lineHeight = font * 1.35;
  const top = h * 0.14;
  const maxChars = Math.floor((w * 0.84) / (font * 0.52));
  const lines = wrapText(scene.imagePrompt, maxChars, Math.max(2, Math.floor((h * 0.24) / lineHeight)));
  const text = lines
    .map((l, k) => `<text x="${w / 2}" y="${top + k * lineHeight}" font-size="${font}" fill="#e8ecf4" text-anchor="middle">${esc(l)}</text>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Helvetica, Arial, sans-serif">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 22%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 40) % 360} 55% 9%)"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<text x="${w / 2}" y="${h * 0.05}" font-size="${unit * 2.4}" fill="#ffffff" fill-opacity="0.45" text-anchor="middle" letter-spacing="${unit * 0.4}">DRAFT · PLACEHOLDER PICTURE</text>` +
    `<text x="${w / 2}" y="${h * 0.09}" font-size="${unit * 2.6}" fill="#9fb0cc" text-anchor="middle">${esc(tags.toUpperCase())}</text>` +
    text +
    "</svg>"
  );
}

/** A silent 16-bit mono WAV of the given length: the narration track of a draft. */
export function silentWav(seconds: number, sampleRate = 8000): Buffer {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const data = samples * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(data, 40);
  return wav;
}
