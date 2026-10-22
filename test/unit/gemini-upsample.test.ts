import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GeminiLlm, upsampleInstructions } from "../../src/providers/gemini.js";
import { UPSAMPLE_DECODING } from "../../src/providers/prompt-version.js";
import { makeImage, tempDir } from "../helpers/media.js";

type Call = { contents: Array<{ parts: Array<{ text?: string; inlineData?: unknown }> }>; config: Record<string, unknown> };

function stubbed(answer: { text?: string; finishReason?: string }) {
  const calls: Call[] = [];
  const llm = new GeminiLlm("key", "model");
  (llm as unknown as { ai: unknown }).ai = {
    models: {
      generateContent: async (args: Call) => {
        calls.push(args);
        return { text: answer.text, candidates: [{ finishReason: answer.finishReason ?? "STOP" }] };
      },
    },
  };
  return { llm, calls };
}

describe("the picture prompt upsampler's call", () => {
  it("turns thinking off and asks with BFL's decoding settings", async () => {
    const { llm, calls } = stubbed({ text: " A caption. " });
    expect(await llm.upsample({ prompt: "a lighthouse" })).toBe("A caption.");
    expect(calls[0].config).toMatchObject({ temperature: 0, topP: 0.95, topK: 20, maxOutputTokens: 3584, thinkingConfig: { thinkingBudget: 0 } });
    expect(UPSAMPLE_DECODING).toEqual({ temperature: 0, topP: 0.95, topK: 20, maxOutputTokens: 3584, thinkingBudget: 0 });
  });

  it("uses the text-to-image instructions alone and the editing ones with the pictures first, then the text", async () => {
    const dir = await tempDir();
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    await makeImage(a, { width: 64, height: 64 });
    await makeImage(b, { width: 64, height: 64, color: "red" });
    const alone = stubbed({ text: "x" });
    await alone.llm.upsample({ prompt: "a lighthouse" });
    expect(alone.calls[0].config.systemInstruction).toBe(upsampleInstructions(false));
    expect(alone.calls[0].contents[0].parts).toHaveLength(1);
    const withPictures = stubbed({ text: "x" });
    await withPictures.llm.upsample({ prompt: "a lighthouse", images: [a, b] });
    expect(withPictures.calls[0].config.systemInstruction).toBe(upsampleInstructions(true));
    const parts = withPictures.calls[0].contents[0].parts;
    expect(parts.map((p) => ("inlineData" in p ? "image" : "text"))).toEqual(["image", "image", "text"]);
  });

  it("fails on a caption that was cut short or is empty, so the stage says so instead of using half a caption", async () => {
    await expect(stubbed({ text: "A half cap", finishReason: "MAX_TOKENS" }).llm.upsample({ prompt: "p" })).rejects.toThrow();
    await expect(stubbed({ text: "A caption", finishReason: "SAFETY" }).llm.upsample({ prompt: "p" })).rejects.toThrow();
    await expect(stubbed({ text: "  " }).llm.upsample({ prompt: "p" })).rejects.toThrow();
  });
});
