import { describe, expect, it } from "vitest";
import { ttsCost } from "../../src/cost.js";
import { runPipeline } from "../../src/pipeline.js";
import { UnusableResultError } from "../../src/providers/retry.js";
import type { SpeakRequest } from "../../src/providers/types.js";
import { scriptStage } from "../../src/stages/script.js";
import { ttsStage } from "../../src/stages/tts.js";
import { makeTestContext } from "../helpers/context.js";

const auto = { budgetUsd: 100, confirm: async () => true, log: () => {} };
const OWN = "runpod:ep-v/voice-voxcpm2@1";

describe("the voice stage with the studio's own voice", () => {
  it("leaves a run on the hosted voice exactly as it was: the same request, the same cache key, priced per character", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1] });
    await runPipeline(ctx, [scriptStage], auto);
    const inputs = (await ttsStage.inputsFor(ctx, 0)) as Record<string, unknown>;
    expect(Object.keys(inputs).sort()).toEqual(["model", "nextText", "previousText", "text", "voiceId"]);
    expect(ttsStage.estimateCostUsd(ctx, 0)).toBe(ttsCost(ctx.prices, ctx.manifest.script!.scenes[0].narration.length));
  });

  it("tells its own voice the script's language, prices a line by GPU seconds, and the run's first line with the start of the worker", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1] });
    await runPipeline(ctx, [scriptStage], auto);
    ctx.manifest.models.tts = OWN;
    const inputs = (await ttsStage.inputsFor(ctx, 1)) as Record<string, unknown>;
    // the language is part of what is bought, so part of the cache key
    expect(inputs).toHaveProperty("language");
    expect(inputs.model).toBe(OWN);
    const chars = ctx.manifest.script!.scenes[1].narration.length;
    const line = Math.round((3 + chars * 0.02) * 0.000306 * 10_000) / 10_000;
    expect(ttsStage.estimateCostUsd(ctx, 1)).toBe(line);
    const first = ctx.manifest.script!.scenes[0].narration.length;
    expect(ttsStage.estimateCostUsd(ctx, 0)).toBe(Math.round((3 + first * 0.02 + 40) * 0.000306 * 10_000) / 10_000);
    // a line costs a fraction of what the hosted voice charged for it
    expect(line).toBeLessThan(ttsCost(ctx.prices, chars) / 10);
  });

  it("charges what the GPU really took where the voice says, and the estimate where it does not", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1] });
    await runPipeline(ctx, [scriptStage], auto);
    ctx.manifest.models.tts = OWN;
    const real = fakes.tts.speak.bind(fakes.tts);
    const seen: SpeakRequest[] = [];
    fakes.tts.speak = async (req: SpeakRequest) => {
      seen.push(req);
      return { ...(await real(req)), ...(seen.length === 1 ? { costUsd: 0.0123 } : {}) };
    };
    await runPipeline(ctx, [scriptStage, ttsStage], auto);
    const spent = ctx.manifest.ledger.filter((e) => e.stage === "tts").map((e) => e.usd);
    expect(spent).toEqual([0.0123, ttsStage.estimateCostUsd(ctx, 1)]);
    // every line of the run is spoken in the one language worked out from the whole script
    expect(new Set(seen.map((r) => r.language)).size).toBe(1);
    expect(ctx.manifest.inFlight).toBeUndefined();
  });

  it("records speech that was made and could not be used: it was paid for all the same", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1] });
    await runPipeline(ctx, [scriptStage], auto);
    ctx.manifest.models.tts = OWN;
    let asked = 0;
    fakes.tts.speak = async () => {
      asked++;
      throw new UnusableResultError("voice job job-2 did not speak the line it was given", 0.0021);
    };
    await expect(runPipeline(ctx, [scriptStage, ttsStage], auto)).rejects.toThrow("did not speak the line");
    expect(ctx.manifest.ledger.filter((e) => e.stage === "tts").map((e) => e.usd)).toEqual([0.0021]);
    expect(ctx.manifest.scenes[0].tts).toBeUndefined();
    expect(asked).toBe(1);
  });

  it("asks its own voice once for a line, whatever goes wrong: each ask buys a job", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1] });
    await runPipeline(ctx, [scriptStage], auto);
    ctx.manifest.models.tts = OWN;
    let asked = 0;
    fakes.tts.speak = async () => {
      asked++;
      throw Object.assign(new Error("RunPod run on endpoint ep-v failed: HTTP 502"), { status: 502 });
    };
    await expect(runPipeline(ctx, [scriptStage, ttsStage], auto)).rejects.toThrow("HTTP 502");
    expect(asked).toBe(1);
  });
});
