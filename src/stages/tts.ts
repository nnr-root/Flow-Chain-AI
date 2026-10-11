import { writeFile } from "node:fs/promises";
import { runpodRates } from "../config.js";
import { FALLBACK_NARRATION_CHARS, round4, ttsCost } from "../cost.js";
import type { Manifest } from "../manifest/schema.js";
import { NonRetryableError, TIMEOUTS, UnusableResultError, withRetry } from "../providers/retry.js";
import { VOICE_WAIT_MS } from "../providers/runpod-voice.js";
import { speechLanguage, VOICES } from "../voice/language.js";
import { hostedVoice } from "../voice/hosted.js";
import { designedClip } from "../voice/library.js";

import { outPath, paths } from "./paths.js";
import { requireScript } from "./require.js";
import type { Stage, StageContext } from "./types.js";
import { withExpectedSpend } from "./inflight.js";

/** Whether the run is spoken by the studio's own voice (its model id says so; every earlier run's does not). */
const ownVoice = (m: Manifest): boolean => m.models.tts.startsWith("runpod:");

function speech(m: Manifest, i: number) {
  const scenes = requireScript(m).scenes;
  const language = m.request.language ?? speechLanguage(scenes.map((s) => s.narration).join(" "));
  return {
    text: scenes[i].narration,
    previousText: scenes[i - 1]?.narration,
    nextText: scenes[i + 1]?.narration,
    voiceId: ownVoice(m) ? m.request.voiceId : hostedVoiceOf(m.request.voiceId, m.request.language),
    // The studio's own voice is told the script's language: the one the run was asked for in, or else worked out
    // from the whole script (so every line of a run is spoken from the same reference clip). The hosted voice is
    // told the language a run was asked for in. Neither is part of an earlier run's request: its cache keys stay.
    ...(ownVoice(m) ? { language } : m.request.language ? { language: m.request.language } : {}),
  };
}

/**
 * The hosted service's voice for one of the studio's voices in a language (phase 5 spec §11). A run made before
 * the catalogue named the service's own voice id, which is sent as it is. One of the studio's voices with no
 * hosted voice chosen is refused before anything is bought: sent as it is, the service would not know it.
 */
function hostedVoiceOf(voiceId: string, language?: string): string {
  const hosted = hostedVoice(voiceId, language);
  if (hosted) return hosted;
  if (Object.hasOwn(VOICES, voiceId)) {
    throw new NonRetryableError(`the voice "${voiceId}" has no hosted voice chosen for it yet (npm run make:voices -- --hosted)`);
  }
  return voiceId;
}

/**
 * What a line is bought from. A designed voice's clip is part of it (a clip made again is another voice); the
 * two narrators' clips are in the worker's image and every earlier run's key stays as it was.
 */
function lineInputs(m: Manifest, i: number) {
  const req = speech(m, i);
  const clip = ownVoice(m) ? designedClip(req.voiceId, req.language) : null;
  return { model: m.models.tts, ...req, ...(clip ? { voiceClip: clip.sha256 } : {}) };
}

/** What a line is expected to cost: per character on the hosted voice (`ttsPer1kChars`), by GPU seconds on the studio's own. */
function lineCost(ctx: Pick<StageContext, "manifest" | "prices">, scene: number, chars: number): number {
  if (!ownVoice(ctx.manifest)) return ttsCost(ctx.prices, chars);
  const r = runpodRates(ctx.prices);
  // the run's first line also pays for the worker to start and load its models
  const seconds = r.voiceSecPerLine + chars * r.voiceSecPerChar + (scene === 0 ? r.voiceColdStartSec : 0);
  return round4(seconds * r.voiceUsdPerSec);
}

export const ttsStage: Stage = {
  name: "tts",
  perScene: true,
  paid: true,
  deps: () => [{ stage: "script" }],
  inputsFor: async (ctx, scene) => lineInputs(ctx.manifest, scene!),
  outputsFor: (_m, scene) => [paths.rawAudio(scene!)],
  estimateCostUsd: (ctx, scene) => lineCost(ctx, scene!, ctx.manifest.script?.scenes[scene!]?.narration.length ?? FALLBACK_NARRATION_CHARS),
  async run(ctx, scene) {
    const i = scene!;
    const req = speech(ctx.manifest, i);
    const cost = lineCost(ctx, i, req.text.length);
    let result: Awaited<ReturnType<typeof ctx.providers.tts.speak>>;
    try {
      result = await withExpectedSpend(ctx, `tts:${i}`, cost, () =>
        withRetry(`tts scene ${i + 1}`, () => ctx.providers.tts.speak(req), {
          // The studio's own voice may first have to start a worker; it waits for that itself. And it is asked
          // once: each ask buys a job, so a failure is the owner's to continue from, never repeated here.
          ...(ownVoice(ctx.manifest) ? { timeoutMs: VOICE_WAIT_MS * 2 + 60_000, attempts: 1 } : { timeoutMs: TIMEOUTS.tts }),
          baseDelayMs: ctx.retryDelayMs,
        }),
      );
    } catch (err) {
      // speech that was made and could not be used was still paid for: it is in the run's record like any other spend
      const cause = err instanceof Error ? err.cause : undefined;
      if (cause instanceof UnusableResultError && cause.costUsd) await ctx.charge(cause.costUsd);
      throw err;
    }
    // what the GPU really took, where that is known; else the estimate
    await ctx.charge(result.costUsd ?? cost);
    await writeFile(await outPath(ctx, paths.rawAudio(i)), result.audio);
    ctx.manifest.scenes[i].tts = { raw: paths.rawAudio(i), words: result.words };
  },
};
