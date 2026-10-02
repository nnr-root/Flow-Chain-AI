import { writeFile } from "node:fs/promises";
import type { Manifest } from "../manifest/schema.js";
import { type CaptionWord, wordsToAss } from "../media/captions.js";
import { audioStarts } from "../media/timeline.js";
import { outPath, paths } from "./paths.js";
import { requireAudio } from "./require.js";
import type { Stage } from "./types.js";

/** Captions follow the speech, so they use cumulative audio starts (≤ ½ frame from the video cuts). */
export function globalWords(m: Manifest): CaptionWord[] {
  const audio = m.scenes.map((s) => requireAudio(s));
  const starts = audioStarts(audio.map((a) => a.duration));
  return audio.flatMap((a, i) => a.words.map((w) => ({ text: w.text, start: w.start + starts[i], end: w.end + starts[i] })));
}

export const captionsStage: Stage = {
  name: "captions",
  perScene: false,
  paid: false,
  deps: (m) => m.scenes.map((s) => ({ stage: "silence" as const, scene: s.idx })),
  inputsFor: async (ctx) => ({ words: globalWords(ctx.manifest), size: ctx.size }),
  outputsFor: () => [paths.captions],
  estimateCostUsd: () => 0,
  async run(ctx) {
    await writeFile(await outPath(ctx, paths.captions), wordsToAss(globalWords(ctx.manifest), ctx.size));
    return 0;
  },
};
