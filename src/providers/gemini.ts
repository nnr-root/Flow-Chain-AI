import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { LlmScript, MAX_NARRATION_WORDS } from "../manifest/schema.js";
import { PRESETS } from "../presets.js";
import type { LlmProvider, ScriptRequest } from "./types.js";

/** Gemini's responseJsonSchema takes plain JSON Schema; drop the draft marker zod adds. */
export function scriptJsonSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(LlmScript) as Record<string, unknown>;
  return schema;
}

export function buildScriptPrompt(req: ScriptRequest): string {
  const orientation =
    req.aspect === "9:16"
      ? "vertical 9:16 (subject centered, tall composition)"
      : "horizontal 16:9 (wide cinematic composition)";
  return [
    `You are writing a faceless short-form video about: "${req.topic}".`,
    `Return exactly ${req.sceneCount} scenes.`,
    "",
    "Style presets (each sets the art style, image and motion wording, and the caption look):",
    ...Object.values(PRESETS).map((p) => `- ${p.name}: ${p.description}`),
    req.style
      ? `- stylePreset: use exactly "${req.style}".`
      : "- stylePreset: set it to the preset that best fits the topic.",
    "",
    "Rules:",
    `- narration: the spoken voiceover for the scene, at most ${MAX_NARRATION_WORDS} words (ideally 12-15), plain text, no stage directions, emojis or hashtags.`,
    "- All narrations together read as one continuous script with a strong hook in scene 1.",
    "- hook: 2-6 punchy words shown as a big title over the first 3 seconds; tease the payoff without giving it away; no emojis, hashtags or quotes.",
    "- styleBible.artStyle: one visual style used by every scene (medium, lighting, lens, mood), matching the style preset.",
    req.characters
      ? `- styleBible.characters: use exactly: "${req.characters}". Refer to these characters consistently in every scene.`
      : '- styleBible.characters: a precise, reusable description of every recurring character (age, clothing, hair, colors), or "none".',
    "- styleBible.palette: 3-5 dominant colors.",
    `- imagePrompt: what a single still frame of the scene shows, ${orientation}. Do not describe the art style or repeat the style bible; they are added automatically. Never ask for text, captions, logos or watermarks.`,
    "- motionPrompt: camera movement plus subject motion during the scene in one or two sentences, physically plausible for a 5-10 second clip.",
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
    ...(req.feedback ? ["", "Your previous answer was rejected for these reasons. Fix them:", req.feedback] : []),
  ].join("\n");
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
      config: { responseMimeType: "application/json", responseJsonSchema: scriptJsonSchema(), temperature: 0.9 },
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
