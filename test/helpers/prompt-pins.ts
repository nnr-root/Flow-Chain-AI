import { createHash } from "node:crypto";
import { AUDIENCE } from "../../src/culture.js";
import { EDITS } from "../../src/edits.js";
import { FORMATS } from "../../src/formats.js";
import { NICHES } from "../../src/niches.js";
import { PRESETS } from "../../src/presets.js";
import { buildScriptPrompt, inspectPrompt } from "../../src/providers/gemini.js";
import { TEMPERATURE } from "../../src/providers/prompt-version.js";
import type { ScriptRequest } from "../../src/providers/types.js";
import { imagePrompt, motionPrompt } from "../../src/stages/visual.js";
import type { SpeechLanguage } from "../../src/voice/language.js";
import { fakeScript } from "../fakes/providers.js";

const base: ScriptRequest = { topic: "The war that lasted 38 minutes", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" };
const timed = { targetSec: 120, sceneSec: { min: 3, max: 5 } };

/** Every prompt text a model is given, for a fixed set of requests: one entry per niche, type, edit, audience and preset, and per kind of answer. */
export function pinnedPrompts(): Record<string, string> {
  const script = fakeScript(3);
  const outline = { title: "T", stylePreset: script.stylePreset, styleBible: script.styleBible, hook: script.hook, hashtags: script.hashtags, parts: [{ summary: "one" }, { summary: "two" }] };
  const out: Record<string, string> = {
    "temperatures": JSON.stringify(TEMPERATURE),
    "whole": buildScriptPrompt(base),
    "whole:timed": buildScriptPrompt({ ...base, timing: { targetSec: 60, sceneSec: { min: 3, max: 5 } } }),
    "whole:shots": buildScriptPrompt({ ...base, shots: ["cut", "continue", "continue", "cut"] }),
    "whole:own-niche": buildScriptPrompt({ ...base, nicheText: "a channel about retro handheld consoles" }),
    "outline": buildScriptPrompt({ ...base, timing: timed, ask: { kind: "outline", partSec: [60, 60] } }),
    "part:0": buildScriptPrompt({ ...base, timing: timed, ask: { kind: "part", index: 0, partSec: [60, 60], outline, previous: [] } }),
    "part:1": buildScriptPrompt({ ...base, timing: timed, ask: { kind: "part", index: 1, partSec: [60, 60], outline, previous: ["Last line one.", "Last line two."] } }),
    "translate": buildScriptPrompt({ ...base, language: "de", ask: { kind: "translate", source: { title: "T", hook: "Hook now", narrations: ["One.", "Two."] }, seconds: [3, 4], from: "en" } }),
    "inspect:one": inspectPrompt({ images: ["a.png"], expected: "a red fox standing" }),
    "inspect:clip": inspectPrompt({ images: ["a.png", "b.png", "c.png"], expected: "a red fox standing" }),
  };
  for (const n of NICHES) out[`niche:${n.id}`] = buildScriptPrompt({ ...base, niche: n.id });
  for (const f of FORMATS) out[`format:${f.id}`] = buildScriptPrompt({ ...base, format: f.id });
  for (const e of EDITS) out[`edit:${e.id}`] = buildScriptPrompt({ ...base, edit: e.id });
  for (const language of Object.keys(AUDIENCE) as SpeechLanguage[]) out[`audience:${language}`] = buildScriptPrompt({ ...base, language, localize: true });
  // what the visual stage adds to each scene's words before a picture or clip model reads them
  for (const [name, preset] of Object.entries(PRESETS)) {
    out[`visual:${name}`] = `${imagePrompt(script as never, 0, preset)}\n${motionPrompt(script as never, 0, preset)}`;
  }
  for (const e of EDITS) out[`visual:edit:${e.id}`] = `${imagePrompt(script as never, 0, null, e)}\n${motionPrompt(script as never, 0, null, e)}`;
  return out;
}

export const hashesOf = (prompts: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(prompts).map(([id, text]) => [id, createHash("sha256").update(text).digest("hex").slice(0, 16)]));
