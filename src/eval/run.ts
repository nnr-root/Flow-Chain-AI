import { z } from "zod";
import { scriptParts, wordsPerSecond } from "../duration.js";
import type { LlmProvider } from "../providers/types.js";
import { validateOutline, validatePart, validateScript, validateTranslation } from "../stages/script.js";
import { type Finding, rawHashtags, startsFromRest, textAsked } from "./checks.js";
import type { EvalCase } from "./cases.js";

export type StepResult = { step: string; accepted: boolean; problems: string[]; extra: Finding[] };
export type JudgeScene = { narration: string; imagePrompt: string; motionPrompt: string; shot: string };
export type CaseOutcome = { steps: StepResult[]; scenes: JudgeScene[] };

const Scenes = z.object({ scenes: z.array(z.object({ narration: z.string(), imagePrompt: z.string(), motionPrompt: z.string(), shot: z.string() }).passthrough()) });
const Tags = z.object({ hashtags: z.array(z.string()).optional() }).passthrough();

const scenesOf = (raw: unknown): JudgeScene[] => {
  const parsed = Scenes.safeParse(raw);
  return parsed.success ? parsed.data.scenes.map(({ narration, imagePrompt, motionPrompt, shot }) => ({ narration, imagePrompt, motionPrompt, shot })) : [];
};
const tagsOf = (raw: unknown): string[] | undefined => {
  const parsed = Tags.safeParse(raw);
  return parsed.success ? parsed.data.hashtags : undefined;
};
const step = (name: string, checked: { ok: boolean; problems?: string[] }, extra: Finding[]): StepResult => ({
  step: name,
  accepted: checked.ok,
  problems: checked.ok ? [] : (checked.problems ?? []),
  extra,
});

/**
 * Asks once for each answer a case needs and checks it with the pipeline's own validators, the way the script
 * stage does (phase 9 spec §6). It never asks again for a rejected answer: that a rejection happened, and why, is
 * the measurement (a rejection is paid for in the studio). A case stops at the first rejection, since what follows
 * would be built on an answer the studio would not have kept.
 */
export async function runCase(llm: Pick<LlmProvider, "generateScript">, c: EvalCase): Promise<CaseOutcome> {
  const req = c.request;
  const { language, voiceId } = req;
  const steps: StepResult[] = [];
  const scenes: JudgeScene[] = [];

  if (req.ask?.kind === "translate") {
    const raw = await llm.generateScript(req);
    const rate = req.wordsPerSecond ?? wordsPerSecond(language, voiceId);
    steps.push(step("translate", validateTranslation(raw, req.ask.seconds, language, rate), rawHashtags(tagsOf(raw))));
    return { steps, scenes };
  }

  const partSec = req.timing ? scriptParts(req.timing.targetSec) : null;
  if (!req.timing || !partSec) {
    const raw = await llm.generateScript(req);
    const found = scenesOf(raw);
    scenes.push(...found);
    steps.push(step("script", validateScript(raw, req.sceneCount, req.timing, language, voiceId, req.wordsPerSecond), [...textAsked(found), ...startsFromRest(found), ...rawHashtags(tagsOf(raw))]));
    return { steps, scenes };
  }

  const outlineRaw = await llm.generateScript({ ...req, ask: { kind: "outline", partSec } });
  const outline = validateOutline(outlineRaw, partSec.length, language);
  steps.push(step("outline", outline, rawHashtags(tagsOf(outlineRaw))));
  if (!outline.ok) return { steps, scenes };

  let previous: string[] = [];
  for (let i = 0; i < partSec.length; i++) {
    const raw = await llm.generateScript({ ...req, ask: { kind: "part", index: i, partSec, outline: outline.value, previous } });
    const found = scenesOf(raw);
    const checked = validatePart(raw, i, partSec[i], req.timing.sceneSec, language, voiceId, req.wordsPerSecond, outline.value.styleBible.setting);
    steps.push(step(`part:${i + 1}`, checked, [...textAsked(found), ...startsFromRest(found)]));
    scenes.push(...found);
    if (!checked.ok) return { steps, scenes };
    previous = found.slice(-2).map((s) => s.narration);
  }
  return { steps, scenes };
}
