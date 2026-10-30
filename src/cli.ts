import { NICHE_IDS, NICHE_TEXT_MAX, nicheById } from "./niches.js";
import { FORMAT_IDS, formatClash } from "./formats.js";
import { EDIT_IDS } from "./edits.js";
import { AUDIENCE } from "./culture.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomInt } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { type BrandKit, installBrand, installReference, loadBrandKit } from "./brand.js";
import { FONTS_DIR } from "./assets.js";
import { type Env, fpsOf, keyframeSize, loadEnv, loadPrices, outputSize } from "./config.js";
import { formatChecks, runDoctor } from "./doctor.js";
import { DEFAULT_SCENE_SECONDS, SCENE_SECONDS, VIDEO_SECONDS, wordsPerSecond } from "./duration.js";
import { type Manifest, MAX_SEED, type Models, RunRequest, StageName } from "./manifest/schema.js";
import {
  createManifest, loadManifest, newRunId, resolveModes, resolveShots, saveManifest, withRunLock,
  resolveShape,
} from "./manifest/store.js";
import { CaptionStyleName, Transition } from "./media/remotion/props.js";
import { type Plan, planRun, RunAborted, runPipeline, sealInherited } from "./pipeline.js";
import { copySourceFiles, versionCapUsd, versionManifest, versionProblem } from "./versions.js";
import { takesSeveralReferences } from "./image-profiles.js";
import { PresetName } from "./presets.js";
import { LANGUAGE_IN_ENGLISH, SPEECH_LANGUAGES, type SpeechLanguage } from "./voice/language.js";
import { GeminiLlm } from "./providers/gemini.js";
import { fetchChart } from "./providers/youtube-chart.js";
import { makeIdeas } from "./trends/run.js";
import { createProviders } from "./providers/factory.js";
import { frozenModePrices, newRunProviders, newRunSound, newRunVoice, restorerFor } from "./providers/new-run.js";
import { CLIP_QUALITIES, type ClipQuality } from "./video-profiles.js";
import type { Providers } from "./providers/types.js";
import { applyRenderOptions, assertRenderOnly, noPaidProviders, withLook } from "./rerender.js";
import { bumpNonce, REROLLABLE } from "./reroll.js";
import { STAGES } from "./stages/index.js";
import type { StageContext } from "./stages/types.js";
import { formatStatus } from "./status.js";
import { planJson, planningCopy, planQuery, RUN_ID, runDraft } from "./studio/commands.js";
import { parseModeOverrides, setDraftModes } from "./studio/draft.js";
import { statusOf } from "./studio/status.js";


try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: rely on the real environment
}

const providersFor = (env: Env, models: Models): Providers => createProviders(env, models, loadPrices());

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

async function requireDoctor(env: Env, models: Models): Promise<void> {
  const checks = await runDoctor(env, FONTS_DIR, models);
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

function cap(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--cap must be a non-negative number, got "${raw}"`);
  return value;
}

function seed(raw: string | undefined): number {
  if (raw === undefined) return randomInt(0, MAX_SEED + 1);
  const value = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_SEED) throw new Error(`--seed must be an integer 0-${MAX_SEED}, got "${raw}"`);
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
    fps: fpsOf(manifest.request),
    fontsDir: FONTS_DIR,
    retryDelayMs: 2000,
    renderConcurrency: concurrency,
    log: (message) => console.log(message),
  };
}

async function execute(
  ctx: StageContext,
  opts: { budgetUsd: number; capUsd?: number; yes?: boolean; reroll?: boolean; from?: StageName; draft?: boolean },
): Promise<void> {
  const { dir, manifest } = ctx;
  const { draft, ...run } = opts;
  try {
    if (draft) await runDraft(ctx, { ...run, confirm: askConfirm });
    else await runPipeline(ctx, STAGES, { ...run, confirm: askConfirm });
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
  if (draft) console.log(`\nDraft: only the script was bought. Continue with: npm run flowchain -- resume ${manifest.runId}`);
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
  hook?: string | false;
  sfx: boolean;
  sfxGain?: string;
  brand?: string;
  characters?: string;
  seed?: string;
  clips?: ClipQuality;
  voice?: string;
  bgm?: string;
  captionStyle?: string;
  transition?: string;
  bgmGain?: string;
  renderConcurrency?: string;
  budget?: string;
  yes?: boolean;
  draft?: boolean;
  runId?: string;
  pinModes?: string;
  duration?: string;
  sceneSeconds?: string;
  language?: string;
  niche?: string;
  nicheText?: string;
  format?: string;
  edit?: string;
  localize?: boolean;
  upscale?: boolean;
  fps?: string;
};

/** --pin-modes: one entry per scene, or a single value for every scene. */
function pins(raw: string | undefined, sceneCount: number): Array<1 | 2 | null> | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseModeOverrides(raw);
  return parsed.length === 1 ? Array.from({ length: sceneCount }, () => parsed[0]) : parsed;
}

/** --run-id: a caller-chosen id in the usual format that no run uses yet. */
function chosenRunId(raw: string | undefined): string {
  if (raw === undefined) return newRunId();
  if (!RUN_ID.test(raw)) throw new Error(`--run-id must look like 20261006-133244-b46307, got "${raw}"`);
  if (existsSync(resolve(runDir(raw), "manifest.json"))) throw new Error(`run ${raw} already exists`);
  return raw;
}

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
  .option("--scenes <n>", "number of scenes (1-12; default 4), for a run asked for by its scenes")
  .addOption(new Option("--language <code>", "the language the video is told in (default: the script model's own choice)").choices(Object.keys(SPEECH_LANGUAGES)))
  .addOption(new Option("--niche <id>", "the kind of video: the script is written as videos in it are (phase 7 spec §19)").choices(NICHE_IDS).conflicts("nicheText"))
  .option("--niche-text <text>", `a niche in your own words, at most ${NICHE_TEXT_MAX} characters (instead of --niche)`)
  .addOption(new Option("--format <id>", "the type of video: how it is told, whatever its niche (phase 8 spec §2)").choices(FORMAT_IDS))
  .addOption(new Option("--edit <id>", "how it moves and is cut: camera, cuts and the finish over the picture (phase 8 spec §3)").choices(EDIT_IDS))
  .option("--no-localize", "with --language: do not make the video for that language's viewers (for a video to be made in other languages too)")
  .option("--duration <seconds>", `about how long the video runs (${VIDEO_SECONDS.join(", ")}); the script decides the number of scenes`)
  .option("--scene-seconds <n|a-b>", `with --duration: how long each scene stays, one length or a range within ${SCENE_SECONDS.min}-${SCENE_SECONDS.max} (default ${DEFAULT_SCENE_SECONDS.min}-${DEFAULT_SCENE_SECONDS.max})`)
  .addOption(
    new Option("--mode <mode>", "auto = per scene from its action level and the budget; 1 or 2 = every scene")
      .choices(["auto", "1", "2"])
      .default("auto"),
  )
  .option("--modes <list>", "per-scene modes, e.g. 1,2,1,1 (overrides --mode)")
  .option("--shots <list>", "testing override: per-scene continue|cut, e.g. cut,continue,continue (default: LLM decides)")
  .addOption(new Option("--style <preset>", "style preset (default: Gemini picks one)").choices(PresetName.options))
  .option("--hook <text>", "hook title for the first seconds (default: Gemini writes one)")
  .option("--no-hook", "no hook title or snap zoom")
  .option("--no-sfx", "no sound effects")
  .option("--sfx-gain <0-1>", "scene-sound level relative to the narration (default: 0.6)")
  .option("--brand <dir>", "brand kit folder (brand.json, logo, optional font): watermark, font, colours, characters")
  .option("--characters <text>", "character bible used in every prompt (default: the brand kit's, else Gemini's)")
  .option("--seed <n>", "seed shared by every keyframe (default: random)")
  .addOption(new Option("--fps <n>", "smooth motion: every moving clip is interpolated and the video is rendered at 60 frames a second (phase 11 spec §2)").choices(["60"]))
  .option("--upscale", "full HD: every moving clip is upscaled to 1080p before it is fitted, at about three times a clip's cost (phase 8 spec §8)")
  .addOption(new Option("--clips <quality>", "the size moving clips are generated at: 480p, or 720p at about twice the cost (default: 480p)").choices(Object.keys(CLIP_QUALITIES)))
  .option("--voice <id>", "voice: narrator-m or narrator-f (default: FLOWCHAIN_VOICE)")
  .option("--bgm <file>", "background music, ducked under the narration")
  .addOption(new Option("--caption-style <style>", "caption look (default: the preset's)").choices(CAPTION_CHOICES))
  .addOption(
    new Option("--transition <kind>", "transition at every cut (default: auto = Gemini's per cut)").choices(TRANSITION_CHOICES),
  )
  .option("--bgm-gain <0-1>", "background music level outside speech (default: 0.35)")
  .option("--render-concurrency <n>", "Remotion render concurrency (default: Remotion's choice)")
  .option("--budget <usd>", "ask before spending more than this (default: FLOWCHAIN_BUDGET_USD)")
  .option("--yes", "never ask for confirmation")
  .option("--draft", "buy only the script and stop; preview and price the run, then resume it")
  .option("--pin-modes <list>", "auto runs: pin scenes to a mode, e.g. auto,1,2,auto (one value = every scene)")
  .option("--run-id <id>", "use this run id instead of a new one")
  .action(async (o: RunFlags) => {
    const env = loadEnv();
    const { sceneCount, timing } = resolveShape(o);
    const clash = formatClash(o.format, nicheById(o.niche)?.kind);
    if (clash) throw new Error(`--format ${o.format} with --niche ${o.niche}: ${clash}`);
    const modes = resolveModes(o.mode, o.modes, sceneCount);
    const shots = resolveShots(o.shots, sceneCount);
    const budgetUsd = budget(o.budget, env);
    if (o.bgm && !existsSync(o.bgm)) throw new Error(`--bgm file not found: ${o.bgm}`);
    const kit: BrandKit | undefined = o.brand ? await loadBrandKit(o.brand) : undefined;
    const providers = newRunProviders(env, o.clips, loadPrices());
    const voice = newRunVoice(env, o.language);
    // scene sound is frozen now, on only when everything it needs is here (phase 14 spec §3); a switch that is on without
    // what it needs says so once, and nothing is said otherwise
    const sound = newRunSound(env, loadPrices(), o.sfx !== false);
    if ("say" in sound && sound.say) console.log(sound.say);
    const request = RunRequest.parse({
      topic: o.topic,
      aspect: o.aspect,
      sceneCount,
      timing,
      language: o.language,
      niche: o.niche,
      nicheText: o.nicheText,
      format: o.format,
      edit: o.edit,
      ...(o.upscale ? { upscale: true } : {}),
      ...(o.fps === "60" ? { fps: 60 as const } : {}),
      ...("model" in sound ? { sceneSound: true as const } : {}),
      // made for the viewers of its one language, frozen now (phase 8 spec §5): never for English, which names no one
      // audience, nor for a video to be made in several languages
      ...(o.language && AUDIENCE[o.language as SpeechLanguage] ? { localize: o.localize !== false } : {}),
      // the words a second its script is asked for, frozen now: a measurement made later changes no bought script
      ...(timing ? { wordsPerSecond: wordsPerSecond(o.language, o.voice ?? voice.voiceId) } : {}),
      // every new run's lines are trimmed so that no word is cut (phase 7 spec §22)
      silence: 2,
      modes,
      // auto runs freeze the budget and price table their mode rules use; a later --budget only changes when to ask
      modeBudgetUsd: modes ? undefined : budgetUsd,
      modePrices: modes ? undefined : frozenModePrices(loadPrices()),
      modeOverrides: pins(o.pinModes, sceneCount),
      shots,
      style: o.style,
      // frozen with the run: they change what is bought
      characters: o.characters ?? kit?.characters,
      seed: seed(o.seed),
      videoProfile: providers.videoProfile,
      imageProfile: providers.imageProfile,
      // frozen with the run: reframe cuts and the shared look reference, only where the picture worker takes several references
      cutReferences: takesSeveralReferences(providers.imageProfile) && env.FLOWCHAIN_CUT_REFERENCES === "on" ? true : undefined,
      voiceId: o.voice ?? voice.voiceId,
      bgm: o.bgm ? resolve(o.bgm) : undefined,
      render: {
        captionStyle: o.captionStyle,
        transition: o.transition,
        bgmGain: o.bgmGain === undefined ? undefined : Number(o.bgmGain),
        hook: o.hook !== false,
        hookText: typeof o.hook === "string" ? o.hook : undefined,
        sfx: o.sfx,
        sfxGain: o.sfxGain === undefined ? undefined : Number(o.sfxGain),
      },
    });
    const restorer = restorerFor(o, env, loadPrices());
    const concurrency = renderConcurrency(o.renderConcurrency);
    const models: Models = {
      llm: env.GEMINI_MODEL,
      tts: voice.model,
      image: providers.image,
      video: providers.video,
      ...(restorer ? { upscale: restorer } : {}),
      ...("model" in sound ? { sound: sound.model } : {}),
    };
    await requireDoctor(env, models);
    const runId = chosenRunId(o.runId);
    const dir = runDir(runId);
    if (kit) {
      request.render.brand = await installBrand(kit, o.brand!, dir);
      request.referenceImage = await installReference(kit, o.brand!, dir);
    }
    const manifest = createManifest(runId, request, models);
    await saveManifest(dir, manifest);
    console.log(`Run ${runId} → ${dir}`);
    const ctx = contextFor(dir, manifest, providersFor(env, models), concurrency);
    await withRunLock(dir, () => execute(ctx, { budgetUsd, yes: o.yes, draft: o.draft }));
  });

program
  .command("resume <runId>")
  .description("continue a run after a failure or interruption")
  .addOption(new Option("--from <stage>", "re-run this stage and every later one").choices(StageName.options))
  .option("--budget <usd>", "ask before spending more than this")
  .option("--cap <usd>", "stop if what this command spends plus what remains would exceed this")
  .option("--render-concurrency <n>", "Remotion render concurrency")
  .option("--yes", "never ask for confirmation")
  .action(async (runId: string, o: { from?: StageName; budget?: string; cap?: string; renderConcurrency?: string; yes?: boolean }) => {
    const env = loadEnv();
    const dir = runDir(runId);
    await loadManifest(dir); // a clear error for an unknown run id, before any lock file is created
    await withRunLock(dir, async () => {
      const manifest = await loadManifest(dir);
      await requireDoctor(env, manifest.models);
      const ctx = contextFor(dir, manifest, providersFor(env, manifest.models), renderConcurrency(o.renderConcurrency));
      await execute(ctx, { budgetUsd: budget(o.budget, env), capUsd: cap(o.cap), yes: o.yes, from: o.from });
    });
  });

program
  .command("translate <runId>")
  .description("make a run in another language: its pictures and clips, with a new narration, voice and captions (phase 8 spec §4)")
  .addOption(new Option("--language <code>", "the language of the version").choices(Object.keys(SPEECH_LANGUAGES)).makeOptionMandatory())
  .option("--voice <id>", "the voice that speaks it (default: the run's own voice, in the new language)")
  .option("--run-id <id>", "use this run id for the version instead of a new one")
  .option("--budget <usd>", "ask before spending more than this (default: FLOWCHAIN_BUDGET_USD)")
  .option("--cap <usd>", "stop if what this command spends plus what remains would exceed this")
  .option("--render-concurrency <n>", "Remotion render concurrency")
  .option("--yes", "never ask for confirmation")
  .action(async (sourceId: string, o: { language: string; voice?: string; runId?: string; budget?: string; cap?: string; renderConcurrency?: string; yes?: boolean }) => {
    const env = loadEnv();
    const sourceDir = runDir(sourceId);
    const source = await loadManifest(sourceDir);
    const language = o.language as SpeechLanguage;
    const problem = versionProblem(source, language);
    if (problem) throw new Error(problem);
    const voice = newRunVoice(env, language);
    const runId = chosenRunId(o.runId);
    const dir = runDir(runId);
    const manifest = versionManifest(source, { runId, language, voiceId: o.voice ?? source.request.voiceId, ttsModel: voice.model, llmModel: env.GEMINI_MODEL });
    await requireDoctor(env, manifest.models);
    // (under the source's lock: nothing of it changes while its files are copied)
    await withRunLock(sourceDir, () => copySourceFiles(sourceDir, dir));
    const ctx = contextFor(dir, manifest, providersFor(env, manifest.models), renderConcurrency(o.renderConcurrency));
    await sealInherited(ctx, STAGES);
    await saveManifest(dir, manifest);
    console.log(`Run ${runId}: ${sourceId} in ${LANGUAGE_IN_ENGLISH[language]} → ${dir}`);
    await withRunLock(dir, () => execute(ctx, { budgetUsd: budget(o.budget, env), capUsd: cap(o.cap), yes: o.yes }));
  });

program
  .command("reroll <runId>")
  .description("regenerate one scene's voiceover, keyframe or clip, or the run's reference portrait (scene 1); later chained clips follow automatically")
  .requiredOption("--scene <n>", "scene number, starting at 1")
  .addOption(new Option("--stage <stage>", "what to regenerate").choices([...REROLLABLE]).makeOptionMandatory())
  .option("--budget <usd>", "spend up to this without asking (default: always ask before a paid reroll)")
  .option("--cap <usd>", "stop if what this command spends plus what remains would exceed this")
  .option("--render-concurrency <n>", "Remotion render concurrency")
  .option("--yes", "never ask for confirmation")
  .action(async (runId: string, o: { scene: string; stage: string; budget?: string; cap?: string; renderConcurrency?: string; yes?: boolean }) => {
    const env = loadEnv();
    const dir = runDir(runId);
    await loadManifest(dir); // a clear error for an unknown run id, before any lock file is created
    await withRunLock(dir, async () => {
      const manifest = await loadManifest(dir);
      bumpNonce(manifest, Number(o.scene), o.stage);
      await requireDoctor(env, manifest.models);
      const ctx = contextFor(dir, manifest, providersFor(env, manifest.models), renderConcurrency(o.renderConcurrency));
      // with an approved amount a reroll is capped like a resume; without one it asks whenever it would spend
      await execute(ctx, { budgetUsd: budget(o.budget, env), capUsd: cap(o.cap), yes: o.yes, reroll: o.budget === undefined });
    });
  });

program
  .command("ideas")
  .description("suggest current topics for a niche and language (one paid model call; prints JSON; the owner's tool and the worker's)")
  .requiredOption("--language <code>", "the language of the video, e.g. en")
  .option("--region <code>", "two-letter region of the audience (default: the language's usual one)")
  .option("--niche <id>", "one of the studio's niches")
  .option("--niche-text <text>", "a niche in the user's own words")
  .option("--format <id>", "the video type")
  .option("--cap <usd>", "the amount the caller holds for this call (the command makes one model call)")
  .action(async (o: { language: string; region?: string; niche?: string; nicheText?: string; format?: string; cap?: string }) => {
    try {
      if (o.niche !== undefined && !NICHE_IDS.includes(o.niche)) throw new Error(`--niche must be one of: ${NICHE_IDS.join(", ")}`);
      if (o.format !== undefined && !FORMAT_IDS.includes(o.format)) throw new Error(`--format must be one of: ${FORMAT_IDS.join(", ")}`);
      if (o.region !== undefined && !/^[A-Za-z]{2}$/.test(o.region)) throw new Error(`--region must be two letters, got "${o.region}"`);
      const env = loadEnv();
      cap(o.cap);
      const llm = new GeminiLlm(env.GEMINI_API_KEY, env.GEMINI_MODEL);
      const { ideas, dropped, usage } = await makeIdeas(
        { llm, chart: (region) => (env.YOUTUBE_API_KEY ? fetchChart(env.YOUTUBE_API_KEY, region) : Promise.resolve([])), today: new Date().toISOString().slice(0, 10) },
        { language: o.language, region: o.region, niche: o.niche, nicheText: o.nicheText, format: o.format },
      );
      console.error(`ideas: ${JSON.stringify(usage ?? {})}`);
      console.log(JSON.stringify({ ideas, dropped }));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

type LookFlagsCli = {
  captionStyle?: string;
  transition?: string;
  bgmGain?: string;
  hook?: string | false;
  hookOn?: boolean;
  sfx?: boolean;
  sfxGain?: string;
  brand?: string | false;
  renderConcurrency?: string;
};

/** The look options `rerender` and `look` share. */
function lookOptions(command: Command): Command {
  return command
    .addOption(new Option("--caption-style <style>", "caption look (preset = the run's style preset)").choices(CAPTION_CHOICES))
    .addOption(new Option("--transition <kind>", "transition at every cut (auto = Gemini's per cut)").choices(TRANSITION_CHOICES))
    .option("--bgm-gain <0-1>", "background music level outside speech")
    .option("--hook <text>", "show this hook title")
    .option("--no-hook", "remove the hook")
    .option("--hook-on", "show the hook again (the script's or the last --hook text)")
    .option("--sfx", "turn sound effects on")
    .option("--no-sfx", "turn sound effects off")
    .option("--sfx-gain <0-1>", "scene-sound level relative to the narration")
    .option("--brand <dir>", "apply this brand kit's look (watermark, font, colours)")
    .option("--no-brand", "remove the brand look");
}

/** Stores new render options in the run (installing a kit's files first); never buys or renders anything. */
async function storeLook(dir: string, manifest: Manifest, o: LookFlagsCli, kit: BrandKit | undefined): Promise<void> {
  applyRenderOptions(manifest, { ...o, brand: o.brand === false ? null : undefined });
  if (kit) applyRenderOptions(manifest, { brand: await installBrand(kit, o.brand as string, dir) });
  await saveManifest(dir, manifest);
}

lookOptions(
  program
    .command("rerender <runId>")
    .description("re-render a finished run with another look (captions, transitions, hook, sound, brand) — free"),
)
  .option("--render-concurrency <n>", "Remotion render concurrency")
  .action(async (runId: string, o: LookFlagsCli) => {
    const dir = runDir(runId);
    await loadManifest(dir); // a clear error for an unknown run id, before any lock file is created
    const kit = typeof o.brand === "string" ? await loadBrandKit(o.brand) : undefined;
    await withRunLock(dir, async () => {
      const manifest = await loadManifest(dir);
      const ctx = contextFor(dir, manifest, noPaidProviders(), renderConcurrency(o.renderConcurrency));
      // planned with the new look but before it is stored, so a refusal leaves the run and its brand files alone: turning
      // sound effects on can make a paid stage due (scene sound never made, phase 14 spec §3); a brand never can
      const looked = withLook(manifest, { ...o, brand: undefined });
      assertRenderOnly(await planRun({ ...ctx, manifest: looked }, STAGES), runId);
      await storeLook(dir, manifest, o, kit);
      await execute(ctx, { budgetUsd: 0, yes: true });
    });
  });

lookOptions(
  program
    .command("look <runId>")
    .description("change a run's look without rendering (any run, also a draft); the next render uses it — free"),
).action(async (runId: string, o: LookFlagsCli) => {
  const dir = runDir(runId);
  await loadManifest(dir); // a clear error for an unknown run id, before any lock file is created
  const kit = typeof o.brand === "string" ? await loadBrandKit(o.brand) : undefined;
  await withRunLock(dir, async () => {
    const manifest = await loadManifest(dir);
    await storeLook(dir, manifest, o, kit);
    console.log(formatStatus(manifest));
  });
});

program
  .command("status <runId>")
  .description("show a run's progress, errors and spend")
  .option("--json", "print the status as JSON")
  .action(async (runId: string, o: { json?: boolean }) => {
    const manifest = await loadManifest(runDir(runId));
    console.log(o.json ? JSON.stringify(statusOf(manifest)) : formatStatus(manifest));
  });

program
  .command("plan <runId>")
  .description("show what continuing a run would do and cost, without doing it")
  .addOption(new Option("--from <stage>", "as if this stage and every later one were re-run").choices(StageName.options))
  .option("--reroll <scene:stage>", "as if this scene's stage were regenerated, e.g. 2:clips")
  .option("--modes <list>", "drafts: as if these modes were pinned, e.g. auto,1,2,auto")
  .addOption(new Option("--translate <code>", "what a version of the run in this language would cost (phase 8 spec §4), and what it holds").choices(Object.keys(SPEECH_LANGUAGES)))
  .option("--voice <id>", "with --translate: the version's voice (default: the run's own)")
  .option("--json", "print the plan as JSON")
  .action(async (runId: string, o: { from?: StageName; reroll?: string; modes?: string; translate?: string; voice?: string; json?: boolean }) => {
    const dir = runDir(runId);
    if (o.translate) {
      const source = await loadManifest(dir);
      const language = o.translate as SpeechLanguage;
      const problem = versionProblem(source, language);
      if (problem) throw new Error(problem);
      const env = loadEnv();
      const manifest = versionManifest(source, { runId: "version", language, voiceId: o.voice ?? source.request.voiceId, ttsModel: newRunVoice(env, language).model, llmModel: env.GEMINI_MODEL });
      // planned against the source's own files, which the version would have: nothing is written anywhere
      const ctx = contextFor(dir, manifest, noPaidProviders(), null);
      await sealInherited(ctx, STAGES);
      const plan = planJson(await planRun(ctx, STAGES));
      const held = { ...plan, capUsd: versionCapUsd(plan.items) };
      if (o.json) console.log(JSON.stringify(held));
      else console.log(`a version in ${LANGUAGE_IN_ENGLISH[language]}: estimated $${plan.totalUsd.toFixed(2)}, held up to $${held.capUsd.toFixed(2)}`);
      return;
    }
    // a copy: pins and reroll nonces are only tried out here, never saved
    const manifest = planningCopy(await loadManifest(dir));
    const [scene, stage] = (o.reroll ?? "").split(":");
    if (o.reroll !== undefined && (!scene || !stage)) throw new Error(`--reroll must look like 2:clips, got "${o.reroll}"`);
    const ctx = contextFor(dir, manifest, noPaidProviders(), null);
    const plan = await planQuery(ctx, STAGES, {
      from: o.from,
      reroll: o.reroll === undefined ? undefined : { scene: Number(scene), stage },
      modes: o.modes === undefined ? undefined : parseModeOverrides(o.modes),
    });
    if (o.json) {
      console.log(JSON.stringify(plan));
      return;
    }
    for (const i of plan.items) {
      const where = i.scene === null ? "run" : `scene ${i.scene}`;
      console.log(`  ${i.stage.padEnd(10)}${where.padEnd(12)}${i.costUsd > 0 ? `$${i.costUsd.toFixed(4)}` : "free"}`);
    }
    console.log(`${plan.items.length} step(s), estimated $${plan.totalUsd.toFixed(2)}`);
  });

program
  .command("draft-modes <runId>")
  .description("pin a draft's scenes to clip (1) or still (2), or back to auto; only before any media is bought")
  .requiredOption("--modes <list>", "one entry per scene, e.g. auto,1,2,auto")
  .option("--json", "print the new estimate as JSON")
  .action(async (runId: string, o: { modes: string; json?: boolean }) => {
    const dir = runDir(runId);
    await loadManifest(dir); // a clear error for an unknown run id, before any lock file is created
    await withRunLock(dir, async () => {
      const manifest = await loadManifest(dir);
      const plan = setDraftModes(manifest, parseModeOverrides(o.modes), keyframeSize(manifest.request.aspect));
      await saveManifest(dir, manifest);
      if (o.json) console.log(JSON.stringify(plan));
      else console.log(`modes ${plan.modes.join(",")} (estimated run total $${plan.estimatedUsd.toFixed(2)})`);
    });
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
