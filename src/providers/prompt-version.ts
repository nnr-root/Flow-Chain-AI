import type { ScriptRequest } from "./types.js";

/**
 * The version of every prompt Gemini is given (phase 9 spec §4). Bump it by hand whenever any prompt text, any
 * imported content file (niches, formats, edits, culture, presets), the text the visual stage adds, or the
 * temperatures below change, and add a line to the spec's changelog. It is recorded with a script but is not in
 * any input hash: changing a prompt must never make an old run buy its script again.
 */
export const PROMPT_VERSION = "2026-10-18.15";

/** How freely each kind of answer is written: the table is part of the prompt version. */
export const TEMPERATURE = { script: 0.9, outline: 0.9, part: 0.7, translate: 0.3, inspect: 0, upsample: 0 } as const;

/**
 * How the picture prompt upsampler is decoded: BFL's own settings, with thinking off as BFL runs it. Part of the
 * pinned table with the temperatures, so a change needs a new version.
 */
export const UPSAMPLE_DECODING = { temperature: TEMPERATURE.upsample, topP: 0.95, topK: 20, maxOutputTokens: 3584, thinkingBudget: 0 } as const;

export const temperatureOf = (req: ScriptRequest): number => TEMPERATURE[req.ask?.kind ?? "script"];
