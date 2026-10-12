import { type LlmRates, round4, scriptCost } from "./cost.js";
import { voicePace } from "./voice/language.js";
import { unitsPerWord } from "./voice/words.js";

/*
 * A video asked for by its length (phase 7 spec): how long the whole of it runs and how long each scene stays,
 * in place of a number of scenes. Everything here is arithmetic, shared by the CLI, the script stage and the
 * studio; nothing in it reads a file or the environment.
 *
 * Audio still drives timing. A length is a target for the writing: the script is asked for so many words, the
 * voice speaks them, and the video is as long as the voice was. So a length is "about", never exact.
 */

/** The lengths a video can be asked for, in seconds: the usual lengths of a short, then whole minutes up to ten. */
export const VIDEO_SECONDS = [5, 10, 15, 20, 30, 45, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600] as const;
export const DEFAULT_VIDEO_SECONDS = 30;

/**
 * How long one scene may be asked to stay, in seconds. Both ends are the clip model's: it makes clips of 33 to
 * 81 frames at 16 a second (`wanFrames`), which is 2.06 to 5.06 seconds. A scene asked for at five seconds whose
 * voice runs a little long is still covered (the fit step slows a clip by up to a quarter).
 */
export const SCENE_SECONDS = { min: 2, max: 5 } as const;
export const DEFAULT_SCENE_SECONDS: SceneSeconds = { min: 3, max: 5 };

/**
 * Words the studio's own voice speaks in a second, pauses trimmed. Measured on the first two videos made by
 * their length on the real engines (2026-10-10): 443 words in 182.9 seconds over 35 scenes, 2.42. (Seven earlier
 * videos of four scenes each had averaged 2.7, and with that both new ones came out long: 34 seconds for 30,
 * 149 for 120.) It is what turns seconds into the words a script is asked for; measure it again if videos
 * drift from their length.
 */
export const WORDS_PER_SECOND = 2.4;

/**
 * The same for the other languages a video can be asked for in. Only English was measured in videos. The
 * others are English scaled by how the same two sentences, said by the same two voices as the samples on the
 * form, compare with the English ones in words a second (`web/content/voice-samples.json`, phase 7 spec §14):
 * an estimate that carries each language's word length and pace, to be measured again with its first videos.
 */
// (samples of 2026-10-10: English 3.23 words a second there against 2.42 in videos, so each is its sample's
// figure times 0.75)
// (Chinese and Japanese are counted in characters, not words: `countUnits`; their figures are characters a second)
const WORDS_PER_SECOND_IN: Record<string, number> = {
  en: WORDS_PER_SECOND, tr: 1.7, es: 2.1, fr: 2.1, de: 1.7, it: 1.9, pt: 1.8, nl: 2.2, pl: 1.8, ru: 1.7, sv: 2.0, da: 1.9, no: 2.0, fi: 1.4, el: 1.6, id: 1.1, ms: 1.6, tl: 1.3, vi: 2.3, bg: 1.8, ro: 2.0, cs: 1.4, hr: 1.6, sk: 1.8, uk: 1.8, hu: 1.6, ja: 3.0, zh: 4.2, ko: 1.5, hi: 2.3, ar: 1.8,
};
export const wordsPerSecond = (language?: string, voice?: string): number =>
  Math.round((WORDS_PER_SECOND_IN[language ?? "en"] ?? WORDS_PER_SECOND) * voicePace(voice) * 100) / 100;

/** The most words one scene's narration may ever have (the script's own limit; about six seconds of speech). */
const MAX_SCENE_WORDS = 16;

/** A video longer than this is written in parts (an outline, then each part), not in one answer. */
export const SINGLE_ANSWER_MAX_SECONDS = 90;
/** About how long one such part runs. */
const PART_SECONDS = 60;

export type SceneSeconds = { min: number; max: number };
export type Timing = { targetSec: number; sceneSec: SceneSeconds };
export type Range = { min: number; max: number };

/** How many scenes a length can be told in: no scene longer than the longest allowed, none shorter than the shortest. */
export function sceneBounds(targetSec: number, sceneSec: SceneSeconds): Range {
  const min = Math.max(1, Math.round(targetSec / sceneSec.max));
  return { min, max: Math.max(min, Math.round(targetSec / sceneSec.min)) };
}

/** The number of scenes to assume before the script says (for laying a run out and pricing its script). */
export function expectedScenes(t: Timing): number {
  const { min, max } = sceneBounds(t.targetSec, t.sceneSec);
  return Math.max(min, Math.min(max, Math.round(t.targetSec / ((t.sceneSec.min + t.sceneSec.max) / 2))));
}

/**
 * The most a scene's narration may have in a language: sixteen words, or in a language without spaces the
 * characters its voice says in the time of sixteen English words.
 */
export const maxSceneUnits = (language: string | undefined, rate: number): number => Math.round(MAX_SCENE_WORDS * unitsPerWord(language, rate));

/** The words of one scene's narration. A scene asked for at one exact length is given a word either way. */
export function sceneWords(sceneSec: SceneSeconds, rate = WORDS_PER_SECOND, most = MAX_SCENE_WORDS): Range {
  const slack = sceneSec.min === sceneSec.max ? 1 : 0;
  const min = Math.max(2, Math.floor(sceneSec.min * rate) - slack);
  return { min, max: Math.max(min, Math.min(most, Math.ceil(sceneSec.max * rate) + slack)) };
}

/** The words a scene has on average when a script uses its range and not only the top of it. */
export function typicalSceneWords(sceneSec: SceneSeconds, rate = WORDS_PER_SECOND): number {
  return Math.round(((sceneSec.min + sceneSec.max) / 2) * rate);
}

/** The words of everything said in `seconds`. */
export const totalWords = (seconds: number, rate = WORDS_PER_SECOND): number => Math.round(seconds * rate);

/**
 * How far the words of an answer may be from what was asked before it is sent back: a seventh, and never less
 * than three words (a five-second video is a dozen words; one word is a twelfth of it).
 */
export function wordsTolerance(words: number): number {
  return Math.max(3, Math.ceil(words * 0.15));
}

/**
 * The seconds of each part a long video is written in, or null for one that is written in a single answer.
 * Parts are equal and about a minute: an answer of thirty scenes at most, which a model keeps to its rules
 * over; two hundred in one answer it does not.
 */
export function scriptParts(targetSec: number): number[] | null {
  if (targetSec <= SINGLE_ANSWER_MAX_SECONDS) return null;
  const count = Math.ceil(targetSec / PART_SECONDS);
  return Array.from({ length: count }, () => Math.round((targetSec / count) * 100) / 100);
}

/**
 * What one answer of `scenes` scenes is priced at. The first scenes are in what a script has always been priced
 * at (`scriptCost`), so a video of a few scenes costs what it did; beyond that an answer grows by its scenes.
 */
export function scriptAnswerCost(p: LlmRates, scenes: number): number {
  const tokens = { input: 1500 + 40 * scenes, output: 500 + 150 * scenes };
  return Math.max(scriptCost(p), round4((tokens.input * p.llmPerMInputTokens + tokens.output * p.llmPerMOutputTokens) / 1e6));
}

/** Every answer a timed script is made of, with the most scenes each may hold: what the script stage buys, in order. */
export function scriptAnswers(t: Timing): Array<{ key: string; scenes: number }> {
  const parts = scriptParts(t.targetSec);
  if (!parts) return [{ key: "script", scenes: sceneBounds(t.targetSec, t.sceneSec).max }];
  // the outline is a few sentences: priced as the smallest answer
  return [{ key: "script:outline", scenes: 0 }, ...parts.map((sec, i) => ({ key: `script:part:${i}`, scenes: sceneBounds(sec, t.sceneSec).max }))];
}

/** What a timed script costs when every answer is accepted the first time. */
export function timedScriptCost(p: LlmRates, t: Timing): number {
  return round4(scriptAnswers(t).reduce((sum, a) => sum + scriptAnswerCost(p, a.scenes), 0));
}

/** Parses `--scene-seconds`: one length ("5") or a range ("3-5"), whole seconds within what a clip can be. */
export function parseSceneSeconds(raw: string): SceneSeconds {
  const m = /^(\d+)(?:-(\d+))?$/.exec(raw.trim());
  const [min, max] = m ? [Number(m[1]), Number(m[2] ?? m[1])] : [Number.NaN, Number.NaN];
  if (!m || min < SCENE_SECONDS.min || max > SCENE_SECONDS.max || min > max) {
    throw new Error(`--scene-seconds must be one length or a range within ${SCENE_SECONDS.min}-${SCENE_SECONDS.max} seconds (for example 5, or 3-5); got "${raw}"`);
  }
  return { min, max };
}

/** Parses `--duration`: one of the lengths a video can be asked for. */
export function parseDuration(raw: string): number {
  const sec = Number(raw);
  if (!(VIDEO_SECONDS as readonly number[]).includes(sec)) {
    throw new Error(`--duration must be one of ${VIDEO_SECONDS.join(", ")} (seconds); got "${raw}"`);
  }
  return sec;
}

/** A length in words: "30 seconds", "1 minute", "10 minutes". */
export function lengthInWords(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
