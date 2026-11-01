import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { computeHash, runPipeline } from "../../src/pipeline.js";
import { clipsStage } from "../../src/stages/clips.js";
import { outPath, paths } from "../../src/stages/paths.js";
import { scriptStage } from "../../src/stages/script.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// A run frozen before speaking clips took their length from the sentence (no `request.speakingClip`) bought its speaking
// clip at 169 frames: its clip's key must stay what it was, or a resume would buy that paid clip again. The literal was
// computed by the code at 4ef5e4f, on this frozen fixture (a fixed script, seed and keyframe file).
const OLD_RUN_SPEAKING_KEY = "451c5e1344ea5e4de1b97adebbc4145808da640e6e9bb87d9f5b053e949a9db3";

describe("a speaking clip of a run frozen before clip lengths came from the sentence", () => {
  it("keeps its key byte for byte", async () => {
    const script = fakeScript(2, { shots: ["cut", "cut"] });
    Object.assign(script.scenes[1], { speech: "Stop adding olive oil to your boiling water, because sauce will slide right off.", narration: "Stop adding olive oil to your boiling water, because sauce will slide right off." });
    const { ctx } = await makeTestContext({ modes: [1, 1], shots: ["cut", "cut"], script: () => script, seed: 7 });
    Object.assign(ctx.manifest.request, { videoProfile: "ltx25@1", language: "en", speech: true });
    ctx.manifest.models.video = "runpod:ep-l/clip-ltx25@1";
    await runPipeline(ctx, [scriptStage], { budgetUsd: 100, confirm: async () => true });
    await writeFile(await outPath(ctx, paths.keyframe(1)), "a frozen keyframe");
    expect(await computeHash(ctx, clipsStage, 1)).toBe(OLD_RUN_SPEAKING_KEY);
  });
});
