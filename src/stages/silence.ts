import { fileSha256 } from "../manifest/hash.js";
import { remapTimings, removeSilence } from "../media/silence.js";
import { abs, outPath, paths } from "./paths.js";
import { requireTts } from "./require.js";
import type { Stage } from "./types.js";

/** How every run made before 2026-10-15 was trimmed: kept for them, so their audio, and their clips, stay as they are. */
export const SILENCE_PARAMS = { noiseDb: -30, minSilence: 0.2, padding: 0.08 };
/**
 * How a run is trimmed since (phase 7 spec §22, `request.silence: 2`): an expressive voice ends a sentence softly and
 * with no silence after it, and -30 dBFS took its last syllable, sometimes its last word, for silence. Silence is now
 * 45 dB under the line's own loudest, no cut enters a word, and every cut fades over 5 ms.
 */
export const SILENCE_PARAMS_2 = { belowPeakDb: 45, minSilence: 0.2, padding: 0.1, fadeMs: 5, endFadeMs: 40, guardWords: true };

const paramsOf = (m: { request: { silence?: number } }) => (m.request.silence === 2 ? SILENCE_PARAMS_2 : SILENCE_PARAMS);

export const silenceStage: Stage = {
  name: "silence",
  perScene: true,
  paid: false,
  deps: (_m, scene) => [{ stage: "tts", scene }],
  inputsFor: async (ctx, scene) => {
    const tts = requireTts(ctx.manifest.scenes[scene!]);
    return { raw: await fileSha256(abs(ctx, tts.raw)), words: tts.words, params: paramsOf(ctx.manifest) };
  },
  outputsFor: (_m, scene) => [paths.audio(scene!)],
  estimateCostUsd: () => 0,
  async run(ctx, scene) {
    const i = scene!;
    const tts = requireTts(ctx.manifest.scenes[i]);
    const p = paramsOf(ctx.manifest);
    const result = await removeSilence(abs(ctx, tts.raw), await outPath(ctx, paths.audio(i)), { ...p, ...("guardWords" in p ? { words: tts.words } : {}) });
    ctx.manifest.scenes[i].audio = {
      path: paths.audio(i),
      duration: result.duration,
      words: remapTimings(tts.words, result.keep),
      removedSec: result.removedSec,
    };
  },
};
