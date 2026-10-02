import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { MAX_NARRATION_WORDS, Script } from "../manifest/schema.js";
import type { LlmProvider, ScriptRequest } from "./types.js";

/** Gemini's responseJsonSchema takes plain JSON Schema; drop the draft marker zod adds. */
export function scriptJsonSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(Script) as Record<string, unknown>;
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
    "Rules:",
    `- narration: the spoken voiceover for the scene, at most ${MAX_NARRATION_WORDS} words, plain text, no stage directions, emojis or hashtags.`,
    "- All narrations together read as one continuous script with a strong hook in scene 1.",
    "- styleBible.artStyle: one visual style used by every scene (medium, lighting, lens, mood).",
    '- styleBible.characters: a precise, reusable description of every recurring character (age, clothing, hair, colors), or "none".',
    "- styleBible.palette: 3-5 dominant colors.",
    `- imagePrompt: what a single still frame of the scene shows, ${orientation}. Do not repeat the style bible; it is added automatically. Never ask for text, captions, logos or watermarks.`,
    "- motionPrompt: camera movement plus subject motion during the scene in one or two sentences, physically plausible for a 5-10 second clip.",
    '- shot: "continue" if the scene happens in the same place and moment as the previous scene and should flow on from its last frame; "cut" for a new location, time or framing. Scene 1 must be "cut".',
    "- camera: the programmatic camera move used if this scene is rendered from a still image.",
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
