import { writeFile } from "node:fs/promises";
import { FALLBACK_NARRATION_CHARS, ttsCost } from "../cost.js";
import type { Manifest } from "../manifest/schema.js";
import { TIMEOUTS, withRetry } from "../providers/retry.js";
import { outPath, paths } from "./paths.js";
import { requireScript } from "./require.js";
import type { Stage } from "./types.js";

function speech(m: Manifest, i: number) {
  const scenes = requireScript(m).scenes;
  return {
    text: scenes[i].narration,
    previousText: scenes[i - 1]?.narration,
    nextText: scenes[i + 1]?.narration,
    voiceId: m.request.voiceId,
  };
}

export const ttsStage: Stage = {
  name: "tts",
  perScene: true,
  paid: true,
  deps: () => [{ stage: "script" }],
  inputsFor: async (ctx, scene) => ({ model: ctx.manifest.models.tts, ...speech(ctx.manifest, scene!) }),
  outputsFor: (_m, scene) => [paths.rawAudio(scene!)],
  estimateCostUsd: (ctx, scene) =>
    ttsCost(ctx.prices, ctx.manifest.script?.scenes[scene!]?.narration.length ?? FALLBACK_NARRATION_CHARS),
  async run(ctx, scene) {
    const i = scene!;
    const req = speech(ctx.manifest, i);
    const result = await withRetry(`tts scene ${i + 1}`, () => ctx.providers.tts.speak(req), {
      timeoutMs: TIMEOUTS.tts,
      baseDelayMs: ctx.retryDelayMs,
    });
    await writeFile(await outPath(ctx, paths.rawAudio(i)), result.audio);
    ctx.manifest.scenes[i].tts = { raw: paths.rawAudio(i), words: result.words };
    return ttsCost(ctx.prices, req.text.length);
  },
};
