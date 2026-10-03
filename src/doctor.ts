import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { Env } from "./config.js";
import type { Models } from "./manifest/schema.js";
import { ElevenLabsTts } from "./providers/elevenlabs.js";
import { checkFal, createFal } from "./providers/fal.js";
import { GeminiLlm } from "./providers/gemini.js";

export type Check = { name: string; ok: boolean; detail: string };

export const REQUIRED_FILTERS = [
  "silencedetect", "atrim", "concat", "zoompan", "ass", "tpad", "xstack", "sidechaincompress", "loudnorm",
];

export function parseFfmpegMajor(versionLine: string): number | null {
  const m = /ffmpeg version n?(\d+)\./.exec(versionLine);
  return m ? Number(m[1]) : null;
}

export async function checkFfmpeg(): Promise<Check[]> {
  const version = await execa("ffmpeg", ["-hide_banner", "-version"], { reject: false });
  if (version.exitCode !== 0) return [{ name: "ffmpeg", ok: false, detail: "not found on PATH (brew install ffmpeg)" }];
  const out = String(version.stdout);
  const firstLine = out.split("\n")[0];
  const major = parseFfmpegMajor(firstLine);
  const filters = String((await execa("ffmpeg", ["-hide_banner", "-filters"], { reject: false })).stdout);
  const missing = REQUIRED_FILTERS.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters));
  const probe = await execa("ffprobe", ["-version"], { reject: false });
  return [
    { name: "ffmpeg version", ok: major === null || major >= 6, detail: firstLine },
    { name: "libass", ok: out.includes("--enable-libass"), detail: "burns captions" },
    { name: "libx264", ok: out.includes("--enable-libx264"), detail: "encodes H.264" },
    { name: "filters", ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "all present" },
    { name: "ffprobe", ok: probe.exitCode === 0, detail: probe.exitCode === 0 ? "found" : "not found on PATH" },
  ];
}

async function attempt(name: string, fn: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** `models` lets resume/reroll check the models frozen in the manifest instead of today's env. */
export async function runDoctor(env: Env, fontsDir: string, models?: Models, voiceId?: string): Promise<Check[]> {
  const llmModel = models?.llm ?? env.GEMINI_MODEL;
  const ttsModel = models?.tts ?? env.ELEVENLABS_MODEL;
  const voice = voiceId ?? env.ELEVENLABS_VOICE_ID;
  const font = join(fontsDir, "Montserrat-ExtraBold.ttf");
  return [
    ...(await checkFfmpeg()),
    { name: "caption font", ok: existsSync(font), detail: font },
    await attempt(`Gemini model ${llmModel}`, async () => {
      await new GeminiLlm(env.GEMINI_API_KEY, llmModel).checkModel();
      return "available";
    }),
    await attempt("fal.ai key", async () => {
      await checkFal(createFal(env.FAL_KEY));
      return "storage upload works";
    }),
    await attempt(`ElevenLabs voice ${voice}`, async () => {
      await new ElevenLabsTts(env.ELEVENLABS_API_KEY, ttsModel).checkVoice(voice);
      return "available";
    }),
  ];
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`).join("\n");
}
