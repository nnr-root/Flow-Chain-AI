import { writeFile } from "node:fs/promises";
import { scriptCost } from "../cost.js";
import { LlmScript, MAX_HOOK_WORDS, MAX_NARRATION_WORDS } from "../manifest/schema.js";
import { PRESETS } from "../presets.js";
import { TIMEOUTS, withRetry } from "../providers/retry.js";
import { outPath, paths } from "./paths.js";
import type { Stage } from "./types.js";
import { withExpectedSpend } from "./inflight.js";

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export type ScriptValidation = { ok: true; script: LlmScript } | { ok: false; problems: string[] };

/** Checks Gemini's answer against LlmScript (the 2.2 fields are required) and the scene and word limits. */
export function validateScript(raw: unknown, sceneCount: number): ScriptValidation {
  const parsed = LlmScript.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const problems: string[] = [];
  if (parsed.data.scenes.length !== sceneCount) {
    problems.push(`expected exactly ${sceneCount} scenes, got ${parsed.data.scenes.length}`);
  }
  parsed.data.scenes.forEach((s, i) => {
    const words = countWords(s.narration);
    if (words > MAX_NARRATION_WORDS) {
      problems.push(`scene ${i + 1} narration has ${words} words (max ${MAX_NARRATION_WORDS})`);
    }
  });
  const hookWords = countWords(parsed.data.hook);
  if (hookWords === 0 || hookWords > MAX_HOOK_WORDS) {
    problems.push(`hook has ${hookWords} words (1-${MAX_HOOK_WORDS})`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, script: parsed.data };
}

export const scriptStage: Stage = {
  name: "script",
  perScene: false,
  paid: true,
  deps: () => [],
  inputsFor: async (ctx) => {
    const { topic, sceneCount, aspect, shots, style, characters } = ctx.manifest.request;
    return { model: ctx.manifest.models.llm, topic, sceneCount, aspect, shots, style, characters };
  },
  outputsFor: () => [paths.script],
  estimateCostUsd: (ctx) => scriptCost(ctx.prices),
  async run(ctx) {
    const { topic, sceneCount, aspect, shots, style, characters } = ctx.manifest.request;
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await withExpectedSpend(ctx, "script", scriptCost(ctx.prices), () =>
        withRetry(
          "script generation",
          () => ctx.providers.llm.generateScript({ topic, sceneCount, aspect, shots, style, characters, feedback }),
          { timeoutMs: TIMEOUTS.llm, baseDelayMs: ctx.retryDelayMs },
        ),
      );
      await ctx.charge(scriptCost(ctx.prices)); // every answer is paid for, valid or not
      const result = validateScript(raw, sceneCount);
      if (result.ok) {
        // --shots is enforced even if the LLM ignored the instruction
        if (shots) result.script.scenes.forEach((s, i) => (s.shot = shots[i]));
        // --style is enforced the same way, and the preset leads the art style (spec §2)
        if (style) result.script.stylePreset = style;
        result.script.styleBible.artStyle = PRESETS[result.script.stylePreset].artStyle;
        // the character bible is enforced too, so every image and motion prompt carries it verbatim
        if (characters) result.script.styleBible.characters = characters;
        ctx.manifest.script = result.script;
        await writeFile(await outPath(ctx, paths.script), `${JSON.stringify(result.script, null, 2)}\n`);
        return;
      }
      feedback = result.problems.join("\n");
      ctx.log(`script rejected:\n${feedback}`);
    }
    throw new Error(`the script failed validation twice:\n${feedback}`);
  },
};
