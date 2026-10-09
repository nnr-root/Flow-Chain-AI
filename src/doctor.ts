import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureBrowser } from "@remotion/renderer";
import { execa } from "execa";
import { EXAMPLE_BRAND_DIR, SFX_DIR } from "./assets.js";
import { loadBrandKit } from "./brand.js";
import type { Env } from "./config.js";
import type { Models } from "./manifest/schema.js";
import { CAPTION_STYLES } from "./media/remotion/styles.js";
import { sfxFiles } from "./media/sfx.js";
import { PRESETS } from "./presets.js";
import { parseModelId } from "./providers/model-id.js";
import { R2 } from "./providers/r2.js";
import { RunpodClient } from "./providers/runpod.js";
import { GeminiLlm } from "./providers/gemini.js";

export type Check = { name: string; ok: boolean; detail: string };

/** ffmpeg still does silence removal, Mode 1 fitting, seam frames, chain.png and the loudness pass. */
export const REQUIRED_FILTERS = ["silencedetect", "atrim", "concat", "tpad", "trim", "xstack", "loudnorm"];

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
    { name: "libx264", ok: out.includes("--enable-libx264"), detail: "encodes H.264" },
    { name: "filters", ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "all present" },
    { name: "ffprobe", ok: probe.exitCode === 0, detail: probe.exitCode === 0 ? "found" : "not found on PATH" },
  ];
}

/** Downloads Chrome Headless Shell once (≈ 100 MB) so a paid run never stalls on it at render time. */
export async function checkRemotionBrowser(): Promise<string> {
  const status = await ensureBrowser();
  if (status.type === "no-browser" || status.type === "version-mismatch") {
    throw new Error(`Remotion has no usable browser (${status.type})`);
  }
  return `ready (${status.path})`;
}

async function attempt(name: string, fn: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Every font a caption can use: the named caption styles' and every style preset's. */
export function captionFontFiles(fontsDir: string): string[] {
  const styles = [...Object.values(CAPTION_STYLES), ...Object.values(PRESETS).map((p) => p.caption)];
  return [...new Set(styles.map((s) => join(fontsDir, s.font.file)))];
}

/** Whether a run buys from the studio's own GPU endpoints; a run made on a retired hosted model has nothing to check. */
export function usesGpu(models?: Models): boolean {
  if (!models) return true;
  return [models.image, models.video].some((id) => parseModelId(id).provider === "runpod");
}

/** Each RunPod endpoint answers /health (no job is bought). */
export async function checkRunpodEndpoints(client: RunpodClient, endpointIds: string[]): Promise<string> {
  for (const id of endpointIds) await client.health(id);
  return `${endpointIds.length} endpoint(s) healthy`;
}

/** A tiny object can be written, read back and deleted, so workers can upload and runs can recover outputs. */
export async function checkR2RoundTrip(r2: R2): Promise<string> {
  const key = `flowchain/doctor-${Date.now()}.txt`;
  let back: string;
  try {
    await r2.put(key, "flowchain doctor");
    back = await r2.get(key);
  } finally {
    await r2.delete(key).catch(() => {}); // best effort: never leave the probe object behind
  }
  if (back !== "flowchain doctor") throw new Error("R2 returned different content");
  return "put, get and delete work";
}

function runpodEndpointIds(env: Env, models?: Models): string[] {
  if (models) {
    return [models.image, models.video]
      .map(parseModelId)
      .flatMap((ref) => (ref.provider === "runpod" ? [ref.endpointId] : []));
  }
  const ids = [env.RUNPOD_KEYFRAME_ENDPOINT, env.RUNPOD_CLIP_ENDPOINT];
  if (ids.some((id) => !id)) throw new Error("RUNPOD_KEYFRAME_ENDPOINT and RUNPOD_CLIP_ENDPOINT must be set (npm run runpod:deploy)");
  return ids as string[];
}

/** `models` lets resume/reroll check the models frozen in the manifest instead of today's env. */
export async function runDoctor(env: Env, fontsDir: string, models?: Models): Promise<Check[]> {
  const llmModel = models?.llm ?? env.GEMINI_MODEL;
  // the studio's own voice: the endpoint of the run's frozen model, else the one new runs would use
  const ownVoice = models ? (models.tts.startsWith("runpod:") ? (parseModelId(models.tts) as { endpointId: string }).endpointId : undefined) : env.RUNPOD_VOICE_ENDPOINT;
  const fonts = captionFontFiles(fontsDir);
  const missingFonts = fonts.filter((f) => !existsSync(f));
  const missingSfx = sfxFiles(SFX_DIR).filter((f) => !existsSync(f));
  return [
    ...(await checkFfmpeg()),
    {
      name: "caption fonts",
      ok: missingFonts.length === 0,
      detail: missingFonts.length ? `missing: ${missingFonts.join(", ")}` : `${fonts.length} bundled`,
    },
    {
      name: "sound effects",
      ok: missingSfx.length === 0,
      detail: missingSfx.length ? `missing: ${missingSfx.join(", ")} (run npm run make:sfx)` : "3 bundled",
    },
    await attempt("example brand kit", async () => `${(await loadBrandKit(EXAMPLE_BRAND_DIR)).name} is valid`),
    await attempt("Remotion browser", checkRemotionBrowser),
    await attempt(`Gemini model ${llmModel}`, async () => {
      await new GeminiLlm(env.GEMINI_API_KEY, llmModel).checkModel();
      return "available";
    }),
    ...(usesGpu(models)
      ? [
          await attempt("RunPod endpoints", async () => {
            if (!env.RUNPOD_API_KEY) throw new Error("RUNPOD_API_KEY is not set");
            return checkRunpodEndpoints(new RunpodClient(env.RUNPOD_API_KEY), runpodEndpointIds(env, models));
          }),
          await attempt("R2 bucket", async () => {
            const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
            if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
              throw new Error("R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set");
            }
            return checkR2RoundTrip(
              new R2({ accountId: R2_ACCOUNT_ID, bucket: R2_BUCKET, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }),
            );
          }),
        ]
      : []),
    // a run spoken by a hosted voice the studio no longer uses has no voice to check: its speech is on disk
    ...(ownVoice
      ? [
          await attempt("voice endpoint", async () => {
            if (!env.RUNPOD_API_KEY) throw new Error("RUNPOD_API_KEY is not set");
            return checkRunpodEndpoints(new RunpodClient(env.RUNPOD_API_KEY), [ownVoice]);
          }),
        ]
      : models
        ? []
        : [{ name: "voice endpoint", ok: false, detail: "RUNPOD_VOICE_ENDPOINT is not set (npm run voice:deploy)" }]),
  ];
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`).join("\n");
}
