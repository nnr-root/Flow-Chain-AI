import { fileSha256 } from "../manifest/hash.js";
import { remapTimings, removeSilence } from "../media/silence.js";
import { abs, outPath, paths } from "./paths.js";
import { requireTts } from "./require.js";
import type { Stage } from "./types.js";

export const SILENCE_PARAMS = { noiseDb: -30, minSilence: 0.2, padding: 0.08 };

export const silenceStage: Stage = {
  name: "silence",
  perScene: true,
  paid: false,
  deps: (_m, scene) => [{ stage: "tts", scene }],
  inputsFor: async (ctx, scene) => {
    const tts = requireTts(ctx.manifest.scenes[scene!]);
    return { raw: await fileSha256(abs(ctx, tts.raw)), words: tts.words, params: SILENCE_PARAMS };
  },
  outputsFor: (_m, scene) => [paths.audio(scene!)],
  estimateCostUsd: () => 0,
  async run(ctx, scene) {
    const i = scene!;
    const tts = requireTts(ctx.manifest.scenes[i]);
    const result = await removeSilence(abs(ctx, tts.raw), await outPath(ctx, paths.audio(i)), SILENCE_PARAMS);
    ctx.manifest.scenes[i].audio = {
      path: paths.audio(i),
      duration: result.duration,
      words: remapTimings(tts.words, result.keep),
      removedSec: result.removedSec,
    };
  },
};
