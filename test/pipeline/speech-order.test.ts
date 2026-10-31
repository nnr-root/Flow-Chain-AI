import { describe, expect, it } from "vitest";
import { planRun, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { STAGES } from "../../src/stages/index.js";
import type { StageContext } from "../../src/stages/types.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 15 spec §4: a run whose script has no speaking scene runs its stages in today's order. The lists below were
// written by the code as it was before the speaking scene existed (commit 98ef71b), and are compared as literals.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

const pairs = async (ctx: StageContext) => (await planRun(ctx, STAGES)).items.map((i) => (i.scene === undefined ? i.stage : `${i.stage}:${i.scene}`));

async function fixture(speech: boolean) {
  const made = await makeTestContext({ modes: "auto", sceneCount: 3, shots: ["cut", "continue", "cut"], actionLevels: ["high", "medium", "low"], budgetUsd: 100 });
  if (speech) made.ctx.manifest.request.speech = true;
  return made;
}

async function plans(speech: boolean) {
  const { ctx } = await fixture(speech);
  const fresh = await pairs(ctx);
  await runPipeline(ctx, STAGES, auto);
  const done = await pairs(ctx);
  const saved = structuredClone(ctx.manifest);
  bumpNonce(ctx.manifest, 2, "tts");
  const voice = await pairs(ctx);
  ctx.manifest = structuredClone(saved);
  bumpNonce(ctx.manifest, 1, "clips");
  const clip = await pairs(ctx);
  return { fresh, done, voice, clip };
}

/** What 98ef71b planned for the fixture: before anything ran, once all of it had, after a voice reroll of scene 2, after a clip reroll of scene 1. */
const TODAY = {
  fresh: ["script", "tts:0", "tts:1", "tts:2", "silence:0", "silence:1", "silence:2", "modes", "keyframes:0", "clips:0", "clips:1", "clips:2", "fit:0", "fit:1", "fit:2", "captions", "render"],
  done: [],
  voice: ["tts:1", "silence:1", "modes", "keyframes:0", "keyframes:2", "clips:0", "clips:1", "fit:0", "fit:1", "captions", "render"],
  clip: ["clips:0", "clips:1", "fit:0", "fit:1", "render"],
};

describe("a run with no speaking scene", () => {
  it.each([
    ["without speech asked for", false],
    ["with speech allowed and no scene speaking", true],
  ])("plans exactly the stages and scenes it planned before speaking scenes existed, %s", async (_label, speech) => {
    expect(await plans(speech as boolean)).toEqual(TODAY);
  });
});
