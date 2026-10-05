import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { type Env, FPS, keyframeSize, loadEnv, loadPrices, outputSize } from "./config.js";
import { formatChecks, runDoctor } from "./doctor.js";
import { type Manifest, type Models, RunRequest, StageName } from "./manifest/schema.js";
import {
  createManifest, loadManifest, newRunId, resolveModes, resolveShots, saveManifest, withRunLock,
} from "./manifest/store.js";
import { CaptionStyleName, Transition } from "./media/remotion/props.js";
import { type Plan, planRun, RunAborted, runPipeline } from "./pipeline.js";
import { PresetName } from "./presets.js";
import { ElevenLabsTts } from "./providers/elevenlabs.js";
import { createFal, FalImage, FalVideo } from "./providers/fal.js";
import { GeminiLlm } from "./providers/gemini.js";
import type { Providers } from "./providers/types.js";
import { applyRenderOptions, assertRenderOnly, noPaidProviders } from "./rerender.js";
import { bumpNonce, REROLLABLE } from "./reroll.js";
import { STAGES } from "./stages/index.js";
import type { StageContext } from "./stages/types.js";
import { formatStatus } from "./status.js";

const FONTS_DIR = resolve(import.meta.dirname, "../assets/fonts");

try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: rely on the real environment
}

function providersFor(env: Env, models: Models): Providers {
  const fal = createFal(env.FAL_KEY);
  return {
    llm: new GeminiLlm(env.GEMINI_API_KEY, models.llm),
    tts: new ElevenLabsTts(env.ELEVENLABS_API_KEY, models.tts),
    image: new FalImage(fal, models.image),
    video: new FalVideo(fal, models.video),
  };
}

async function askConfirm(_plan: Plan, reason: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(`Confirmation needed (${reason}) but stdin is not interactive; re-run with --yes.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`Proceed (${reason})? [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function requireDoctor(env: Env, models: Models, voiceId?: string): Promise<void> {
  const checks = await runDoctor(env, FONTS_DIR, models, voiceId);
  if (checks.every((c) => c.ok)) return;
  console.error(formatChecks(checks));
  throw new Error("flowchain doctor failed: fix the items marked ✗ above");
}

function budget(raw: string | undefined, env: Env): number {
  if (raw === undefined) return env.FLOWCHAIN_BUDGET_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--budget must be a non-negative number, got "${raw}"`);
  return value;
}

function renderConcurrency(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--render-concurrency must be a positive integer, got "${raw}"`);
  return value;
}

const CAPTION_CHOICES = ["preset", ...CaptionStyleName.options];
const TRANSITION_CHOICES = ["auto", ...Transition.options];

const runsDir = () => process.env.RUNS_DIR ?? "./runs";
const runDir = (runId: string) => resolve(runsDir(), runId);

function contextFor(dir: string, manifest: Manifest, providers: Providers, concurrency: number | null): StageContext {
  return {
    dir,
    manifest,
    providers,
    prices: loadPrices(),
    size: outputSize(manifest.request.aspect),
    keyframeSize: keyframeSize(manifest.request.aspect),
    fps: FPS,
    fontsDir: FONTS_DIR,
    retryDelayMs: 2000,
    renderConcurrency: concurrency,
    log: (message) => console.log(message),
  };
}

async function execute(
  ctx: StageContext,
  opts: { budgetUsd: number; yes?: boolean; reroll?: boolean; from?: StageName },
): Promise<void> {
  const { dir, manifest } = ctx;
  try {
    await runPipeline(ctx, STAGES, { ...opts, confirm: askConfirm });
  } catch (err) {
    if (err instanceof RunAborted) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    console.error(`\nResume with: npm run flowchain -- resume ${manifest.runId}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${formatStatus(manifest)}`);
  if (manifest.final) {
    console.log(`\nVideo:       ${resolve(dir, manifest.final.path)}`);
    console.log(`Chain sheet: ${resolve(dir, manifest.final.chain)}`);
  }
}

type RunFlags = {
  topic: string;
  aspect: string;
  scenes: string;
  mode: string;
  modes?: string;
  shots?: string;
  style?: string;
  voice?: string;
  bgm?: string;
  captionStyle?: string;
  transition?: string;
  bgmGain?: string;
  renderConcurrency?: string;
  budget?: string;
  yes?: boolean;
};

const program = new Command()
  .name("flowchain")
  .description("Flow-Chain-AI: topic → captioned short video with a continuity chain, rendered with Remotion");

program
  .command("doctor")
  .description("check ffmpeg, fonts, API keys and model availability")
  .action(async () => {
    const env = loadEnv();
    const checks = await runDoctor(env, FONTS_DIR);
    console.log(formatChecks(checks));
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  });

program
  .command("run")
  .description("start a new run")
  .requiredOption("--topic <text>", "what the video is about")
  .addOption(new Option("--aspect <ratio>", "output aspect ratio").choices(["9:16", "16:9"]).default("9:16"))
  .option("--scenes <n>", "number of scenes (1-12)", "4")
  .addOption(
    new Option("--mode <mode>", "auto = per scene from its action level and the budget; 1 or 2 = every scene")
      .choices(["auto", "1", "2"])
      .default("auto"),
  )
  .option("--modes <list>", "per-scene modes, e.g. 1,2,1,1 (overrides --mode)")
  .option("--shots <list>", "testing override: per-scene continue|cut, e.g. cut,continue,continue (default: LLM decides)")
  .addOption(new Option("--style <preset>", "style preset (default: Gemini picks one)").choices(PresetName.options))
  .option("--voice <id>", "ElevenLabs voice id (default: ELEVENLABS_VOICE_ID)")
  .option("--bgm <file>", "background music, ducked under the narration")
  .addOption(new Option("--caption-style <style>", "caption look (default: the preset's)").choices(CAPTION_CHOICES))
  .addOption(
    new Option("--transition <kind>", "transition at every cut (default: auto = Gemini's per cut)").choices(TRANSITION_CHOICES),
  )
  .option("--bgm-gain <0-1>", "background music level outside speech (default: 0.35)")
  .option("--render-concurrency <n>", "Remotion render concurrency (default: Remotion's choice)")
  .option("--budget <usd>", "ask before spending more than this (default: FLOWCHAIN_BUDGET_USD)")
  .option("--yes", "never ask for confirmation")
  .action(async (o: RunFlags) => {
    const env = loadEnv();
    const sceneCount = Number(o.scenes);
    const modes = resolveModes(o.mode, o.modes, sceneCount);
    const shots = resolveShots(o.shots, sceneCount);
    const budgetUsd = budget(o.budget, env);
    if (o.bgm && !existsSync(o.bgm)) throw new Error(`--bgm file not found: ${o.bgm}`);
    const request = RunRequest.parse({
      topic: o.topic,
      aspect: o.aspect,
      sceneCount,
      modes,
      // auto runs freeze the budget and price table their mode rules use; a later --budget only changes when to ask
      modeBudgetUsd: modes ? undefined : budgetUsd,
      modePrices: modes ? undefined : loadPrices(),
      shots,
      style: o.style,
      voiceId: o.voice ?? env.ELEVENLABS_VOICE_ID,
      bgm: o.bgm ? resolve(o.bgm) : undefined,
      render: {
        captionStyle: o.captionStyle,
        transition: o.transition,
        bgmGain: o.bgmGain === undefined ? undefined : Number(o.bgmGain),
      },
    });
    const concurrency = renderConcurrency(o.renderConcurrency);
    const models: Models = {
      llm: env.GEMINI_MODEL,
      tts: env.ELEVENLABS_MODEL,
      image: env.FAL_IMAGE_MODEL,
      video: env.FAL_VIDEO_MODEL,
    };
    await requireDoctor(env, models, request.voiceId);
    const runId = newRunId();
    const dir = runDir(runId);
    const manifest = createManifest(runId, request, models);
    await saveManifest(dir, manifest);
    console.log(`Run ${runId} → ${dir}`);
    const ctx = contextFor(dir, manifest, providersFor(env, models), concurrency);
    await withRunLock(dir, () => execute(ctx, { budgetUsd, yes: o.yes }));
  });

program
  .command("resume <runId>")
  .description("continue a run after a failure or interruption")
  .addOption(new Option("--from <stage>", "re-run this stage and every later one").choices(StageName.options))
  .option("--budget <usd>", "ask before spending more than this")
  .option("--render-concurrency <n>", "Remotion render concurrency")
  .option("--yes", "never ask for confirmation")
  .action(async (runId: string, o: { from?: StageName; budget?: string; renderConcurrency?: string; yes?: boolean }) => {
    const env = loadEnv();
    const dir = runDir(runId);
    await loadManifest(dir); // a clear error for an unknown run id, before any lock file is created
    await withRunLock(dir, async () => {
      const manifest = await loadManifest(dir);
      await requireDoctor(env, manifest.models, manifest.request.voiceId);
      const ctx = contextFor(dir, manifest, providersFor(env, manifest.models), renderConcurrency(o.renderConcurrency));
      await execute(ctx, { budgetUsd: budget(o.budget, env), yes: o.yes, from: o.from });
    });
  });

program
  .command("reroll <runId>")
  .description("regenerate one scene's voiceover, keyframe or clip; later chained clips follow automatically")
  .requiredOption("--scene <n>", "scene number, starting at 1")
  .addOption(new Option("--stage <stage>", "what to regenerate").choices([...REROLLABLE]).makeOptionMandatory())
  .option("--render-concurrency <n>", "Remotion render concurrency")
  .option("--yes", "never ask for confirmation")
  .action(async (runId: string, o: { scene: string; stage: string; renderConcurrency?: string; yes?: boolean }) => {
    const env = loadEnv();
    const dir = runDir(runId);
    await loadManifest(dir); // a clear error for an unknown run id, before any lock file is created
    await withRunLock(dir, async () => {
      const manifest = await loadManifest(dir);
      bumpNonce(manifest, Number(o.scene), o.stage);
      await requireDoctor(env, manifest.models, manifest.request.voiceId);
      const ctx = contextFor(dir, manifest, providersFor(env, manifest.models), renderConcurrency(o.renderConcurrency));
      await execute(ctx, { budgetUsd: budget(undefined, env), yes: o.yes, reroll: true });
    });
  });

program
  .command("rerender <runId>")
  .description("re-render a finished run with another look (caption style, transition, BGM level) — free")
  .addOption(new Option("--caption-style <style>", "caption look (preset = the run's style preset)").choices(CAPTION_CHOICES))
  .addOption(new Option("--transition <kind>", "transition at every cut (auto = Gemini's per cut)").choices(TRANSITION_CHOICES))
  .option("--bgm-gain <0-1>", "background music level outside speech")
  .option("--render-concurrency <n>", "Remotion render concurrency")
  .action(
    async (
      runId: string,
      o: { captionStyle?: string; transition?: string; bgmGain?: string; renderConcurrency?: string },
    ) => {
      const dir = runDir(runId);
      await loadManifest(dir); // a clear error for an unknown run id, before any lock file is created
      await withRunLock(dir, async () => {
        const manifest = await loadManifest(dir);
        applyRenderOptions(manifest, o);
        const ctx = contextFor(dir, manifest, noPaidProviders(), renderConcurrency(o.renderConcurrency));
        assertRenderOnly(await planRun(ctx, STAGES), runId);
        await saveManifest(dir, manifest);
        await execute(ctx, { budgetUsd: 0, yes: true });
      });
    },
  );

program
  .command("status <runId>")
  .description("show a run's progress, errors and spend")
  .action(async (runId: string) => {
    console.log(formatStatus(await loadManifest(runDir(runId))));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
