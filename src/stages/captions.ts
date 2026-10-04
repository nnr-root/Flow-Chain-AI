import { writeFile } from "node:fs/promises";
import type { Manifest } from "../manifest/schema.js";
import { type TimedWord, wordsToCaptions } from "../media/remotion/caption-pages.js";
import { audioStarts } from "../media/timeline.js";
import { captionStyleFor } from "./look.js";
import { outPath, paths } from "./paths.js";
import { requireAudio } from "./require.js";
import type { Stage } from "./types.js";

/** Captions follow the speech, so they use cumulative audio starts (≤ ½ frame from the video cuts). */
export function globalWords(m: Manifest): TimedWord[] {
  const audio = m.scenes.map((s) => requireAudio(s));
  const starts = audioStarts(audio.map((a) => a.duration));
  return audio.flatMap((a, i) => a.words.map((w) => ({ text: w.text, start: w.start + starts[i], end: w.end + starts[i] })));
}

/** Words per caption page come from the run's caption style, so changing the style re-runs this (free) stage. */
const maxWordsPerPage = (m: Manifest) => captionStyleFor(m).maxWordsPerPage;

export const captionsStage: Stage = {
  name: "captions",
  perScene: false,
  paid: false,
  deps: (m) => m.scenes.map((s) => ({ stage: "silence" as const, scene: s.idx })),
  inputsFor: async (ctx) => ({ words: globalWords(ctx.manifest), maxWordsPerPage: maxWordsPerPage(ctx.manifest) }),
  outputsFor: () => [paths.captions],
  estimateCostUsd: () => 0,
  async run(ctx) {
    const captions = wordsToCaptions(globalWords(ctx.manifest), maxWordsPerPage(ctx.manifest));
    await writeFile(await outPath(ctx, paths.captions), `${JSON.stringify(captions, null, 2)}\n`);
  },
};
