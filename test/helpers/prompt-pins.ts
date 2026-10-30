import { createHash } from "node:crypto";
import { AUDIENCE } from "../../src/culture.js";
import { EDITS } from "../../src/edits.js";
import { FORMATS } from "../../src/formats.js";
import { NICHES } from "../../src/niches.js";
import { PRESETS } from "../../src/presets.js";
import { buildScriptPrompt, inspectPrompt, inspectSchema, scriptJsonSchema, upsampleInstructions, upsampleUserText } from "../../src/providers/gemini.js";
import { TEMPERATURE, UPSAMPLE_DECODING } from "../../src/providers/prompt-version.js";
import type { ScriptRequest } from "../../src/providers/types.js";
import { ideasPrompt } from "../../src/trends/prompt.js";
import { REFERENCE_NOTE } from "../../src/stages/references.js";
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
    "temperatures": JSON.stringify({ TEMPERATURE, UPSAMPLE_DECODING }),
    "whole": buildScriptPrompt(base),
    "whole:timed": buildScriptPrompt({ ...base, timing: { targetSec: 60, sceneSec: { min: 3, max: 5 } } }),
    "whole:shots": buildScriptPrompt({ ...base, shots: ["cut", "continue", "continue", "cut"] }),
    "whole:own-niche": buildScriptPrompt({ ...base, nicheText: "a channel about retro handheld consoles" }),
    "outline": buildScriptPrompt({ ...base, timing: timed, ask: { kind: "outline", partSec: [60, 60] } }),
    "part:0": buildScriptPrompt({ ...base, timing: timed, ask: { kind: "part", index: 0, partSec: [60, 60], outline, previous: [] } }),
    "part:1": buildScriptPrompt({ ...base, timing: timed, ask: { kind: "part", index: 1, partSec: [60, 60], outline, previous: ["Last line one.", "Last line two."] } }),
    "translate": buildScriptPrompt({ ...base, language: "de", ask: { kind: "translate", source: { title: "T", hook: "Hook now", narrations: ["One.", "Two."] }, seconds: [3, 4], from: "en" } }),
    "inspect:one": inspectPrompt({ images: ["a.png"], expected: "a red fox standing" }),
    "inspect:references": inspectPrompt({ images: ["a.png"], expected: "x", references: ["r.png"], checkContent: true }),
    "inspect:clip": inspectPrompt({ images: ["a.png", "b.png", "c.png"], expected: "a red fox standing" }),
  };
  // the topic-ideas prompt (phase 13): a known niche with a chart, and a niche of the user's own with none
  const ideasBase = { language: "en", region: "US", today: "2026-10-30" };
  out["ideas"] = ideasPrompt({ ...ideasBase, niche: "history", chart: [{ title: "The lost city under the lake", channel: "Deep Time", categoryId: "27", views: 1200000 }, { title: "Why bridges hum", channel: "Spans", categoryId: "28", views: 85000 }] });
  out["ideas:custom"] = ideasPrompt({ ...ideasBase, nicheText: "a channel about retro handheld consoles", chart: [] });
  // the layered branches: a niche with a type, and an outline or a part with every layer
  const layers = { niche: "history", format: "documentary", edit: "calm", language: "de", localize: true } as const;
  out["layered:history+countdown"] = buildScriptPrompt({ ...base, niche: "history", format: "countdown" });
  out["layered:scary-stories+pov"] = buildScriptPrompt({ ...base, niche: "scary-stories", format: "pov" });
  out["layered:own-niche+versus"] = buildScriptPrompt({ ...base, nicheText: "a channel about retro handheld consoles", format: "versus" });
  out["layered:outline"] = buildScriptPrompt({ ...base, ...layers, timing: timed, ask: { kind: "outline", partSec: [60, 60] } });
  out["layered:part:1"] = buildScriptPrompt({ ...base, ...layers, timing: timed, ask: { kind: "part", index: 1, partSec: [60, 60], outline, previous: ["Last line one.", "Last line two."] } });
  out["whole:reframe"] = buildScriptPrompt({ ...base, format: "story", reframe: true });
  // the response schemas: a field added to one reaches every run's model, so a change needs a new version too
  out["schema:script"] = JSON.stringify(scriptJsonSchema("script", 16));
  out["schema:script:reframe"] = JSON.stringify(scriptJsonSchema("script", 16, true));
  out["schema:part"] = JSON.stringify(scriptJsonSchema("part", 16));
  out["schema:part:reframe"] = JSON.stringify(scriptJsonSchema("part", 16, true));
  out["schema:outline"] = JSON.stringify(scriptJsonSchema("outline", 16));
  out["schema:translate"] = JSON.stringify(scriptJsonSchema("translate", 16));
  out["schema:inspect"] = JSON.stringify(inspectSchema(false));
  out["schema:inspect:content"] = JSON.stringify(inspectSchema(true));
  out["references:note"] = REFERENCE_NOTE;
  out["upsample:t2i"] = upsampleInstructions(false) + "\n" + upsampleUserText("a lighthouse at dusk", 0);
  out["upsample:i2i"] = upsampleInstructions(true) + "\n" + upsampleUserText("a lighthouse at dusk", 2);
  out["part:1:reframe"] = buildScriptPrompt({ ...base, timing: timed, format: "documentary", reframe: true, ask: { kind: "part", index: 1, partSec: [60, 60], outline, previous: ["Last line one."] } });
  out["whole:style+characters"] = buildScriptPrompt({ ...base, style: "anime", characters: "a red fox" });
  out["whole:feedback"] = buildScriptPrompt({ ...base, feedback: "scene 2 narration has 20 words" });
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
