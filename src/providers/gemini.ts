import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { lengthInWords, maxSceneUnits, sceneBounds, sceneWords, totalWords, typicalSceneWords, wordsPerSecond } from "../duration.js";
import { hookCap, isUnspaced, lengthUnit, unitsPerWord } from "../voice/words.js";
import { LANGUAGE_IN_ENGLISH } from "../voice/language.js";
import { LlmOutline, LlmPart, LlmScript, MAX_COUNTED_SCENES, MAX_NARRATION_WORDS } from "../manifest/schema.js";
import { PRESETS } from "../presets.js";
import type { LlmProvider, ScriptRequest } from "./types.js";

/** Gemini's responseJsonSchema takes plain JSON Schema; drop the draft marker zod adds. */
export function scriptJsonSchema(kind: "script" | "outline" | "part" = "script", most: number = MAX_COUNTED_SCENES): Record<string, unknown> {
  const of = kind === "outline" ? LlmOutline : kind === "part" ? LlmPart : LlmScript;
  const { $schema: _ignored, ...schema } = z.toJSONSchema(of) as Record<string, unknown>;
  // The model's service refuses a schema whose list of scenes may be long: tried against it on 2026-10-10, a
  // limit of 12 or 16 is taken and one of 24, 54 or 360 is answered "invalid argument", while no limit at all is
  // taken. So a short list says its limit, as it always has, and a longer one says none: how many scenes an
  // answer has is checked when it comes back, whatever the schema said.
  const list = (schema.properties as Record<string, { maxItems?: number }>)[kind === "outline" ? "parts" : "scenes"];
  if (most <= MAX_COUNTED_SCENES) list.maxItems = most;
  else delete list.maxItems;
  return schema;
}

/** The most entries the answer to a request may have: what the script stage would still accept (see `timingProblems`). */
export function mostEntries(req: ScriptRequest): number {
  if (req.ask?.kind === "outline") return req.ask.partSec.length;
  if (!req.timing) return MAX_COUNTED_SCENES;
  const sec = req.ask?.kind === "part" ? req.ask.partSec[req.ask.index] : req.timing.targetSec;
  return Math.ceil(sceneBounds(sec, req.timing.sceneSec).max * 1.2);
}

const seconds = (r: { min: number; max: number }): string => (r.min === r.max ? `about ${r.min}` : `${r.min} to ${r.max}`);

/** What a stretch of a video asked for by its length must come to: its words, and the scenes it may be told in. */
function lengthRules(what: string, sec: number, sceneSec: { min: number; max: number }, language?: string, voice?: string): string[] {
  const rate = wordsPerSecond(language, voice);
  const words = sceneWords(sceneSec, rate, maxSceneUnits(language, rate));
  const scenes = sceneBounds(sec, sceneSec);
  // (in Chinese and Japanese, counted in characters: phase 7 spec §17)
  const unit = lengthUnit(language);
  return [
    `Length: ${what} runs about ${Math.round(sec)} seconds when spoken. The voice speaks about ${rate} ${unit} a second, so all its narrations together are about ${totalWords(sec, rate)} ${unit}. Count them: far fewer and the video is too short, far more and it is too long.`,
    `Each scene stays on screen for ${seconds(sceneSec)} seconds, so each scene's narration is ${words.min} to ${words.max} ${unit}.`,
    // (asked for on 2026-10-10 without this, the model wrote every scene at the top of its range, and the video ran a fifth long)
    ...(sceneSec.min === sceneSec.max ? [] : [`Use the whole range: on average a scene is about ${typicalSceneWords(sceneSec, rate)} ${unit}. Do not write every scene at the longest length; the total number of ${unit} is what decides how long the video runs, and it must not be exceeded.`]),
    scenes.min === scenes.max
      ? `Return exactly ${scenes.min} ${scenes.min === 1 ? "scene" : "scenes"}.`
      : `Return between ${scenes.min} and ${scenes.max} scenes. You decide how many and how long each one is, within those limits: a quick beat gets a short scene, a thought that needs room a longer one.`,
  ];
}

const presetRules = (req: ScriptRequest): string[] => [
  "Style presets (each sets the art style, image and motion wording, and the caption look), with the topics each one suits:",
  ...Object.values(PRESETS).map((p) => `- ${p.name}: ${p.description}`),
  req.style
    ? `- stylePreset: use exactly "${req.style}".`
    : "- stylePreset: set it to the preset that best fits the topic.",
];

const HOOK_RULE = "- hook: 2-6 punchy words shown as a big title over the first 3 seconds; tease the payoff without giving it away; no emojis, hashtags or quotes.";
/** The hook's rule: in words, or in a language without spaces in characters (`hookCap`). */
const hookRule = (req: ScriptRequest): string =>
  isUnspaced(req.language)
    ? `- hook: a punchy title of at most ${hookCap(req.language, wordsPerSecond(req.language, req.voiceId))} characters shown big over the first 3 seconds; tease the payoff without giving it away; no emojis, hashtags or quotes.`
    : HOOK_RULE;

/**
 * The hashtags a video is posted with (phase 7 spec §18): in its language and its own script, as the people who
 * speak it tag such videos, from the subject's field to this video's own subject; none of the tags put on every
 * video, which bring nobody who wants this one.
 */
const hashtagRule = (req: ScriptRequest): string =>
  `- hashtags: exactly 5, to post the video with on Shorts, Reels and TikTok. Write them in ${req.language ? LANGUAGE_IN_ENGLISH[req.language] : "the language of the narration"}, in its own script and spelling, the way people who speak it tag videos like this one (not translated from English tags). Each starts with # and is one word, or words run together with no spaces or punctuation. Go from broad to specific: one or two for the field the subject belongs to, the rest for this video's own subject. No generic tags (#fyp, #foryou, #viral, #shorts, #trending, or the like), and no names of real people or brands unless the video is about them.`;

const bibleRules = (req: ScriptRequest): string[] => [
  "- styleBible.artStyle: one visual style used by every scene (medium, lighting, lens, mood), matching the style preset.",
  req.characters
    ? `- styleBible.characters: use exactly: "${req.characters}". Refer to these characters consistently in every scene they appear in.`
    : '- styleBible.characters: a precise, reusable description of every recurring character (age, clothing, hair, colors), or "none".',
  "- styleBible.palette: 3-5 dominant colors, as plain colour names.",
];

/** The rules for a scene's own fields: the same whether the script is written in one answer or in parts. */
function sceneRules(req: ScriptRequest): string[] {
  const orientation =
    req.aspect === "9:16"
      ? "vertical 9:16 (subject centered, tall composition)"
      : "horizontal 16:9 (wide cinematic composition)";
  const clip = req.timing ? `a clip of ${req.timing.sceneSec.min === req.timing.sceneSec.max ? req.timing.sceneSec.min : `${req.timing.sceneSec.min}-${req.timing.sceneSec.max}`} seconds` : "a 5-10 second clip";
  return [
    `- imagePrompt: what a single still frame of the scene shows, ${orientation}. Do not describe the art style or repeat the style bible; they are added automatically. Never ask for text, captions, logos or watermarks.`,
    "- imagePrompt, how to write it: one or two plain sentences that a painter could work from. Name one clear main subject and what it is doing, where it is, how close the camera is (close-up, medium shot or wide shot) and from where it looks, and the light or time of day. Only things that can be seen: no feelings, ideas, metaphors, sounds or story. Say what is in the frame, never what is absent from it. Every scene's frame must differ from the one before it in subject, distance or angle.",
    "- showsCharacter: true only when a recurring character is visible in the scene's frame, and then the imagePrompt says what they are doing; false for a scene of a place, an object or a detail, whose imagePrompt must not mention them.",
    `- motionPrompt: camera movement plus subject motion during the scene in one or two sentences, physically plausible for ${clip}.`,
    "- motionPrompt, how to write it: one camera move (for example a slow push-in, a pan left, an orbit, a tilt up, or a static camera) and one or two simple motions of things already in the frame. Nothing new enters the frame, nothing changes place or shape, and nobody speaks to the camera. Do not describe how anything looks.",
    '- shot: "continue" if the scene happens in the same place and moment as the previous scene and should flow on from its last frame; "cut" for a new location, time or framing. Scene 1 must be "cut".',
    "- camera: the programmatic camera move used if this scene is rendered from a still image.",
    '- actionLevel: "high" for fast or complex motion worth real video, "medium" for some motion, "low" for still, contemplative or text-like moments.',
    '- suggestedTransition: how the cut into this scene should feel: "cut" for punchy or continuous energy, "fade" or "dissolve" for time passing or a mood shift, "zoom_transition" for an energetic jump. Scene 1\'s value is ignored.',
    ...(req.shots
      ? [
          `- Use exactly these shot values, in order: ${req.shots.map((s, i) => `scene ${i + 1} "${s}"`).join(", ")}. ` +
            'Write every "continue" scene (its imagePrompt and motionPrompt) as the same place and moment carrying on.',
        ]
      : []),
  ];
}

const narrationRule = (req: ScriptRequest): string => {
  const rate = wordsPerSecond(req.language, req.voiceId);
  const most = maxSceneUnits(req.language, rate);
  const unit = lengthUnit(req.language);
  const k = unitsPerWord(req.language, rate);
  const each = req.timing ? sceneWords(req.timing.sceneSec, rate, most) : undefined;
  return each
    ? `- narration: the spoken voiceover for the scene, ${each.min} to ${each.max} ${unit} and never more than ${most}, plain text, no stage directions, emojis or hashtags.`
    : `- narration: the spoken voiceover for the scene, at most ${most} ${unit} (ideally ${Math.round(12 * k)}-${Math.round(15 * k)}), plain text, no stage directions, emojis or hashtags.`;
};

/**
 * The language a video is told in, when one was asked for. What is heard and read is in it; what the picture
 * and clip models read stays in English, which is what they follow best.
 */
const languageRule = (req: ScriptRequest, spoken: string): string[] =>
  req.language
    ? [`- Language: write ${spoken} in ${LANGUAGE_IN_ENGLISH[req.language]}, the way a native speaker would say it aloud. Write every imagePrompt and motionPrompt, and the styleBible, in English.`]
    : [];

const feedbackLines = (req: ScriptRequest): string[] => (req.feedback ? ["", "Your previous answer was rejected for these reasons. Fix them:", req.feedback] : []);

/** The whole script in one answer: by a number of scenes, or (`timing`) by its length. */
function wholePrompt(req: ScriptRequest): string {
  return [
    `You are writing a faceless short-form video about: "${req.topic}".`,
    ...(req.timing ? lengthRules("the video", req.timing.targetSec, req.timing.sceneSec, req.language, req.voiceId) : [`Return exactly ${req.sceneCount} scenes.`]),
    "",
    ...presetRules(req),
    "",
    "Rules:",
    ...languageRule(req, "the title, the hook and every narration"),
    narrationRule(req),
    "- All narrations together read as one continuous script with a strong hook in scene 1.",
    hookRule(req),
    hashtagRule(req),
    ...bibleRules(req),
    ...sceneRules(req),
    ...feedbackLines(req),
  ].join("\n");
}

/** A long video's first answer: what every part shares, and what each part tells. */
function outlinePrompt(req: ScriptRequest, partSec: number[]): string {
  const total = partSec.reduce((a, b) => a + b, 0);
  return [
    `You are planning a faceless video about: "${req.topic}".`,
    `It runs about ${lengthInWords(Math.round(total))} and is told by one narrator over pictures. It will be written in ${partSec.length} parts of about ${Math.round(partSec[0])} seconds each; here you plan them, and write none of the narration.`,
    "",
    ...presetRules(req),
    "",
    "Rules:",
    ...languageRule(req, "the title, the hook and every part's summary"),
    "- title: the video's title.",
    hookRule(req),
    hashtagRule(req),
    ...bibleRules(req),
    `- parts: exactly ${partSec.length}, in order. For each, summary: what that part tells, in one or two plain sentences, specific enough that someone else could write it.`,
    "- The parts together are one story with a direction: part 1 opens on the hook and makes a promise, each part adds something the ones before did not, and the last part pays the promise off. No part repeats another, and none is filler.",
    ...feedbackLines(req),
  ].join("\n");
}

/** One part of a long video: its scenes, written to carry on from the part before. */
function partPrompt(req: ScriptRequest, ask: Extract<NonNullable<ScriptRequest["ask"]>, { kind: "part" }>): string {
  const { index, partSec, outline, previous } = ask;
  const [first, last] = [index === 0, index === partSec.length - 1];
  const sceneSec = req.timing!.sceneSec;
  return [
    `You are writing part ${index + 1} of ${partSec.length} of a faceless video about: "${req.topic}".`,
    `The video is called "${outline.title}". One narrator tells it over pictures; the parts are joined end to end into one video.`,
    "",
    "What each part tells:",
    ...outline.parts.map((p, i) => `${i + 1}. ${p.summary}`),
    "",
    `Write only part ${index + 1}: its scenes, in order.`,
    ...lengthRules("this part", partSec[index], sceneSec, req.language, req.voiceId),
    first
      ? "- This is the opening: scene 1 is a strong hook."
      : `- This part carries straight on from the end of part ${index}, whose last lines were: ${previous.map((n) => `"${n}"`).join(" ")} Do not greet, do not introduce the topic again, and do not repeat what an earlier part has told.`,
    last ? "- This is the end of the video: its last scene lands the payoff and closes." : "- Do not conclude or sum up: the next part carries on from your last line.",
    "",
    "The look is settled, and is added to every picture automatically:",
    `- style preset: ${outline.stylePreset}`,
    `- characters: ${req.characters ?? outline.styleBible.characters}`,
    `- palette: ${outline.styleBible.palette}`,
    "",
    "Rules:",
    ...languageRule(req, "every narration"),
    narrationRule(req),
    "- The narrations of this part read as one continuous script.",
    ...sceneRules(req),
    ...feedbackLines(req),
  ].join("\n");
}

export function buildScriptPrompt(req: ScriptRequest): string {
  if (req.ask?.kind === "outline") return outlinePrompt(req, req.ask.partSec);
  if (req.ask?.kind === "part") return partPrompt(req, req.ask);
  return wholePrompt(req);
}

export class GeminiLlm implements LlmProvider {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateScript(req: ScriptRequest): Promise<unknown> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: buildScriptPrompt(req),
      config: { responseMimeType: "application/json", responseJsonSchema: scriptJsonSchema(req.ask?.kind ?? "script", mostEntries(req)), temperature: 0.9 },
    });
    const text = res.text;
    if (!text) throw new Error("Gemini returned an empty response");
    return JSON.parse(text);
  }

  /** Fails with a clear API error when the model id is retired or misspelled. */
  async checkModel(): Promise<void> {
    await this.ai.models.get({ model: this.model });
  }
}
