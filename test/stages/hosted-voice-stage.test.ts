import { describe, expect, it, vi } from "vitest";
import { runPipeline } from "../../src/pipeline.js";
import type { SpeakRequest } from "../../src/providers/types.js";
import { scriptStage } from "../../src/stages/script.js";
import { ttsStage } from "../../src/stages/tts.js";
import { makeTestContext } from "../helpers/context.js";

// The catalogue the owner fills (assets/voices/elevenlabs.json), as it might be: Storyteller has a Turkish voice
// of its own, the narrator only an English one.
vi.mock("../../src/voice/hosted.js", () => ({
  hostedVoice: (role: string, language?: string) => {
    const voices: Record<string, Record<string, string>> = { storyteller: { en: "StoryEn0001", tr: "StoryTr0001" }, "narrator-m": { en: "NarrEn00001" } };
    const by = voices[role];
    return by ? (language && by[language]) || by.en || null : null;
  },
}));

const auto = { budgetUsd: 100, confirm: async () => true, log: () => {} };
const HOSTED = "eleven_multilingual_v2";

describe("the voice stage with the hosted voice (phase 5 spec §11)", () => {
  it("speaks one of the studio's voices in the hosted voice chosen for the run's language, and tells it the language", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1] });
    ctx.manifest.models.tts = HOSTED;
    ctx.manifest.request.voiceId = "storyteller";
    ctx.manifest.request.language = "tr";
    const seen: SpeakRequest[] = [];
    const real = fakes.tts.speak.bind(fakes.tts);
    fakes.tts.speak = async (req: SpeakRequest) => (seen.push(req), real(req));
    await runPipeline(ctx, [scriptStage, ttsStage], auto);
    expect(seen.map((r) => [r.voiceId, r.language])).toEqual([["StoryTr0001", "tr"], ["StoryTr0001", "tr"]]);
    // the voice it was spoken in is part of what was bought: a voice chosen again is another voice
    expect(await ttsStage.inputsFor(ctx, 0)).toMatchObject({ voiceId: "StoryTr0001", language: "tr" });
  });

  it("speaks a language no voice was chosen in with the voice's English one", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1] });
    await runPipeline(ctx, [scriptStage], auto);
    ctx.manifest.models.tts = HOSTED;
    ctx.manifest.request.voiceId = "narrator-m";
    ctx.manifest.request.language = "pt";
    expect(await ttsStage.inputsFor(ctx, 0)).toMatchObject({ voiceId: "NarrEn00001", language: "pt" });
  });

  it("refuses one of the studio's voices that has no hosted voice yet, before anything is bought", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1] });
    ctx.manifest.models.tts = HOSTED;
    ctx.manifest.request.voiceId = "upbeat";
    let asked = 0;
    fakes.tts.speak = async () => {
      asked++;
      throw new Error("not to be asked");
    };
    await expect(runPipeline(ctx, [scriptStage, ttsStage], auto)).rejects.toThrow(/the voice "upbeat" has no hosted voice chosen for it yet/);
    expect(asked).toBe(0);
    expect(ctx.manifest.ledger.filter((e) => e.stage === "tts")).toEqual([]);
  });

  it("sends a run made before the catalogue its own voice id, and keeps its cache key as it was", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1] });
    await runPipeline(ctx, [scriptStage], auto);
    ctx.manifest.models.tts = HOSTED;
    const inputs = (await ttsStage.inputsFor(ctx, 0)) as Record<string, unknown>;
    expect(inputs.voiceId).toBe("voice-1");
    expect(Object.keys(inputs).sort()).toEqual(["model", "nextText", "previousText", "text", "voiceId"]);
  });
});
