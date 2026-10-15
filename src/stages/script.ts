import { writeFile } from "node:fs/promises";
import { scriptCost } from "../cost.js";
import { maxSceneUnits, type SceneSeconds, sceneBounds, sceneWords, scriptAnswerCost, scriptParts, timedScriptCost, type Timing, totalWords, wordsPerSecond, wordsTolerance } from "../duration.js";
import { LlmOutline, LlmPart, LlmScript, MAX_HOOK_WORDS, MAX_NARRATION_WORDS } from "../manifest/schema.js";
import { layOutScenes } from "../manifest/store.js";
import { PRESETS } from "../presets.js";
import { voicePace } from "../voice/language.js";
import { countUnits, hookCap, isUnspaced, lengthUnit, unitsPerWord } from "../voice/words.js";
import { normalizeHashtags } from "../hashtags.js";
import { TIMEOUTS, withRetry } from "../providers/retry.js";
import type { ScriptRequest } from "../providers/types.js";
import { outPath, paths } from "./paths.js";
import type { RunContext, Stage } from "./types.js";
import { withExpectedSpend } from "./inflight.js";

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export type ScriptValidation = { ok: true; script: LlmScript } | { ok: false; problems: string[] };
type Checked<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

/** The hook fits on the screen: six words at most, or in a language without spaces the characters that say as much. */
function hookProblems(hook: string, language?: string): string[] {
  const words = countUnits(hook, language);
  const most = isUnspaced(language) ? hookCap(language) : MAX_HOOK_WORDS;
  return words === 0 || words > most ? [`hook has ${words} ${lengthUnit(language)} (1-${most})`] : [];
}

/**
 * Whether scenes keep to a length they were asked for (phase 7 spec §3). The limits here are wider than the
 * ones the model was given: an answer is paid for whether or not it is accepted, and the video's real length
 * is the voice's in any case, so only an answer that would come out clearly wrong is sent back.
 */
export function timingProblems(scenes: Array<{ narration: string }>, sec: number, sceneSec: SceneSeconds, what = "the script", rate?: number, language?: string): string[] {
  const problems: string[] = [];
  const bounds = sceneBounds(sec, sceneSec);
  const [fewest, most] = [Math.max(1, Math.floor(bounds.min * 0.8)), Math.ceil(bounds.max * 1.2)];
  if (scenes.length < fewest || scenes.length > most) {
    problems.push(`${what} has ${scenes.length} scenes; it must have between ${bounds.min} and ${bounds.max}`);
  }
  // (counted in words, or in Chinese and Japanese in characters, with limits that say as much: phase 7 spec §17)
  const unit = lengthUnit(language);
  const cap = isUnspaced(language) ? maxSceneUnits(language, rate ?? wordsPerSecond(language)) : MAX_NARRATION_WORDS;
  const near = isUnspaced(language) ? Math.round(2 * unitsPerWord(language, rate ?? wordsPerSecond(language))) : 2;
  const each = sceneWords(sceneSec, rate, cap);
  let total = 0;
  scenes.forEach((s, i) => {
    const words = countUnits(s.narration, language);
    total += words;
    if (words > cap) problems.push(`scene ${i + 1} narration has ${words} ${unit} (max ${cap})`);
    else if (words > each.max + near || words < Math.max(1, each.min - near)) {
      problems.push(`scene ${i + 1} narration has ${words} ${unit}; a scene of ${sceneSec.min === sceneSec.max ? sceneSec.min : `${sceneSec.min}-${sceneSec.max}`} seconds has ${each.min} to ${each.max}`);
    }
  });
  const wanted = totalWords(sec, rate);
  const slack = wordsTolerance(wanted);
  if (Math.abs(total - wanted) > slack) {
    problems.push(`the narrations of ${what} have ${total} ${unit} in all; ${Math.round(sec)} seconds of speech are about ${wanted} (between ${wanted - slack} and ${wanted + slack})`);
  }
  return problems;
}

/**
 * Checks Gemini's answer against LlmScript (the 2.2 fields are required) and the scene and word limits: exactly
 * `sceneCount` scenes, or, for a run asked for by its length, the scenes and words that length comes to.
 */
export function validateScript(raw: unknown, sceneCount: number, timing?: Timing, language?: string, voice?: string, frozen?: number): ScriptValidation {
  const parsed = LlmScript.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: issues(parsed.error) };
  const problems: string[] = [];
  const rate = frozen ?? wordsPerSecond(language, voice);
  if (timing) problems.push(...timingProblems(parsed.data.scenes, timing.targetSec, timing.sceneSec, "the script", rate, language));
  else {
    if (parsed.data.scenes.length !== sceneCount) {
      problems.push(`expected exactly ${sceneCount} scenes, got ${parsed.data.scenes.length}`);
    }
    const most = isUnspaced(language) ? maxSceneUnits(language, rate) : MAX_NARRATION_WORDS;
    parsed.data.scenes.forEach((s, i) => {
      const words = countUnits(s.narration, language);
      if (words > most) {
        problems.push(`scene ${i + 1} narration has ${words} ${lengthUnit(language)} (max ${most})`);
      }
    });
  }
  problems.push(...hookProblems(parsed.data.hook, language));
  // (hashtags are put right, never a reason to send an answer back: phase 7 spec §18)
  return problems.length > 0 ? { ok: false, problems } : { ok: true, script: { ...parsed.data, hashtags: normalizeHashtags(parsed.data.hashtags) } };
}

/** A long video's outline: the right number of parts, and a hook that fits on the screen. */
export function validateOutline(raw: unknown, parts: number, language?: string): Checked<LlmOutline> {
  const parsed = LlmOutline.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: issues(parsed.error) };
  const problems = hookProblems(parsed.data.hook, language);
  if (parsed.data.parts.length !== parts) problems.push(`expected exactly ${parts} parts, got ${parsed.data.parts.length}`);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { ...parsed.data, hashtags: normalizeHashtags(parsed.data.hashtags) } };
}

/** One part of a long video: scenes that come to the part's own seconds. */
export function validatePart(raw: unknown, index: number, sec: number, sceneSec: SceneSeconds, language?: string, voice?: string, frozen?: number): Checked<LlmPart["scenes"]> {
  const parsed = LlmPart.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: issues(parsed.error) };
  const problems = timingProblems(parsed.data.scenes, sec, sceneSec, `part ${index + 1}`, frozen ?? wordsPerSecond(language, voice), language);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: parsed.data.scenes };
}

/**
 * Buys one answer, twice at most: an answer that is sent back is asked for again with what was wrong with it.
 * Every answer is paid for, accepted or not. `keep` puts an accepted answer in the manifest before its charge is
 * recorded, so that the save that records the charge records the answer with it.
 */
async function answer<T>(ctx: RunContext, key: string, usd: number, req: ScriptRequest, check: (raw: unknown) => Checked<T>, keep?: (value: T) => void): Promise<T> {
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await withExpectedSpend(ctx, key, usd, () =>
      withRetry("script generation", () => ctx.providers.llm.generateScript({ ...req, feedback }), { timeoutMs: req.timing ? TIMEOUTS.llmLong : TIMEOUTS.llm, baseDelayMs: ctx.retryDelayMs }),
    );
    const result = check(raw);
    if (result.ok) keep?.(result.value);
    await ctx.charge(usd); // every answer is paid for, valid or not
    if (result.ok) return result.value;
    feedback = result.problems.join("\n");
    ctx.log(`script rejected:\n${feedback}`);
  }
  throw new Error(`the script failed validation twice:\n${feedback}`);
}

/** A long video's script: the outline, then each part with the last lines of the one before it. Bought answers are kept. */
async function writeInParts(ctx: RunContext, req: ScriptRequest, timing: Timing, partSec: number[]): Promise<LlmScript> {
  const m = ctx.manifest;
  // answers kept from an earlier, stopped execution are for these same inputs, or they are not used
  if (m.scriptParts?.inputHash !== ctx.inputHash) m.scriptParts = { inputHash: ctx.inputHash, parts: [] };
  const kept = m.scriptParts;
  const outline = kept.outline ?? (await answer(ctx, "script:outline", scriptAnswerCost(ctx.prices, 0), { ...req, ask: { kind: "outline", partSec } },
    (raw) => validateOutline(raw, partSec.length, req.language), (value) => (kept.outline = value)));
  for (let i = kept.parts.length; i < partSec.length; i++) {
    const previous = (kept.parts[i - 1] ?? []).slice(-2).map((s) => s.narration);
    await answer(ctx, `script:part:${i}`, scriptAnswerCost(ctx.prices, sceneBounds(partSec[i], timing.sceneSec).max), { ...req, ask: { kind: "part", index: i, partSec, outline, previous } },
      (raw) => validatePart(raw, i, partSec[i], timing.sceneSec, req.language, req.voiceId, req.wordsPerSecond), (value) => kept.parts.push(value));
    ctx.log(`script: part ${i + 1} of ${partSec.length} written (${kept.parts[i].length} scenes)`);
  }
  // every part begins on a fresh picture: nothing of the part before is there to carry on from when it is written
  for (const part of kept.parts) part[0].shot = "cut";
  return { title: outline.title, stylePreset: outline.stylePreset, styleBible: outline.styleBible, hook: outline.hook, ...(outline.hashtags ? { hashtags: outline.hashtags } : {}), scenes: kept.parts.flat() } as LlmScript;
}

export const scriptStage: Stage = {
  name: "script",
  perScene: false,
  paid: true,
  deps: () => [],
  inputsFor: async (ctx) => {
    const { topic, sceneCount, aspect, shots, style, characters, timing, language, niche, nicheText, wordsPerSecond: frozen } = ctx.manifest.request;
    // (a language is part of the key only when one was asked for, so every earlier run keeps its key; the words a
    // second the run froze, or for a run made before that the voice's pace where it is not the narrators'; and a
    // niche only when one was given)
    const pace = voicePace(ctx.manifest.request.voiceId, language);
    const asked = {
      ...(language ? { language } : {}),
      ...(frozen ? { wordsPerSecond: frozen } : pace !== 1 ? { pace } : {}),
      ...(niche ? { niche } : {}),
      ...(nicheText ? { nicheText } : {}),
    };
    // a run asked for by its length is keyed on that: its number of scenes is the script's own answer
    if (timing) return { model: ctx.manifest.models.llm, topic, timing, aspect, shots, style, characters, ...asked };
    return { model: ctx.manifest.models.llm, topic, sceneCount, aspect, shots, style, characters, ...asked };
  },
  outputsFor: () => [paths.script],
  estimateCostUsd: (ctx) => (ctx.manifest.request.timing ? timedScriptCost(ctx.prices, ctx.manifest.request.timing) : scriptCost(ctx.prices)),
  async run(ctx) {
    const { topic, sceneCount, aspect, shots, style, characters, timing, language, niche, nicheText, wordsPerSecond: frozen } = ctx.manifest.request;
    const voiceId = ctx.manifest.request.voiceId;
    const req: ScriptRequest = { topic, sceneCount, aspect, shots, style, characters, timing, language, voiceId, niche, nicheText, ...(frozen ? { wordsPerSecond: frozen } : {}) };
    const partSec = timing ? scriptParts(timing.targetSec) : null;
    const script = timing && partSec
      ? await writeInParts(ctx, req, timing, partSec)
      : await answer(ctx, "script", timing ? scriptAnswerCost(ctx.prices, sceneBounds(timing.targetSec, timing.sceneSec).max) : scriptCost(ctx.prices), req, (raw) => {
          const result = validateScript(raw, sceneCount, timing, language, voiceId, frozen);
          return result.ok ? { ok: true, value: result.script } : result;
        });
    // --shots is enforced even if the LLM ignored the instruction
    if (shots) script.scenes.forEach((s, i) => (s.shot = shots[i]));
    // there is no earlier clip for the first scene to carry on from
    if (timing) script.scenes[0].shot = "cut";
    // --style is enforced the same way, and the preset leads the art style (spec §2)
    if (style) script.stylePreset = style;
    const preset = PRESETS[script.stylePreset];
    script.styleBible.artStyle = preset.artStyle;
    // a look that is a palette keeps it: a black-and-white film told "warm amber and teal" comes out in colour
    if (preset.palette) script.styleBible.palette = preset.palette;
    // the character bible is enforced too, so every image and motion prompt carries it verbatim
    if (characters) script.styleBible.characters = characters;
    ctx.manifest.script = script;
    // a run asked for by its length learns here how many scenes it has
    if (timing) layOutScenes(ctx.manifest, script.scenes.length);
    delete ctx.manifest.scriptParts;
    await writeFile(await outPath(ctx, paths.script), `${JSON.stringify(script, null, 2)}\n`);
  },
};
