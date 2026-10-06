import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Mode } from "../../src/manifest/schema.js";
import { loadManifest } from "../../src/manifest/store.js";
import { cellSize } from "../../src/media/contact-sheet.js";
import { extractLastFrame } from "../../src/media/frames.js";
import { countFrames, probeVideo, streamDuration } from "../../src/media/ffmpeg.js";
import { type Plan, planRun, RunAborted, type RunOptions, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { STAGES } from "../../src/stages/index.js";
import { abs, paths } from "../../src/stages/paths.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";
import { frameDiff } from "../helpers/media.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

describe("end-to-end with fakes", () => {
  it("renders a hybrid 1,2,1,1 video with a 4-row chain sheet", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 2, 1, 1], shots: ["cut", "continue", "continue", "cut"] });
    await runPipeline(ctx, STAGES, auto);
    const final = abs(ctx, paths.final);
    const total = ctx.manifest.scenes.reduce((a, s) => a + s.audio!.duration, 0);
    expect(await countFrames(final)).toBe(Math.round(total * 30));
    const drift = Math.abs((await streamDuration(final, "v")) - (await streamDuration(final, "a")));
    expect(drift).toBeLessThanOrEqual(1 / 30);
    const cell = cellSize(ctx.size);
    const sheet = await probeVideo(abs(ctx, paths.chain));
    expect(sheet.height).toBe(cell.height * 4);
  });

  it("resumes after a rejected clip submission without repeating any completed paid call", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1, 1] });
    fakes.video.failSubmit = (req) => req.prompt.startsWith("motion 3");
    await expect(runPipeline(ctx, STAGES, auto)).rejects.toThrow(/clip scene 3: submit failed \(not retried, nothing recorded as bought\)/);
    expect(fakes.video.submits).toHaveLength(2); // a submit is never retried

    const saved = await loadManifest(ctx.dir);
    expect(saved.scenes[2].stages.clips?.status).toBe("failed");
    expect(saved.scenes[2].jobs.clips).toBeUndefined();

    fakes.video.failSubmit = undefined;
    await runPipeline({ ...ctx, manifest: saved }, STAGES, auto);
    expect(fakes.llm.calls).toHaveLength(1);
    expect(fakes.tts.calls).toHaveLength(4);
    expect(fakes.image.submits).toHaveLength(1);
    expect(fakes.video.submits).toHaveLength(4); // + scenes 3 and 4
    const final = await loadManifest(ctx.dir);
    expect(final.final).toBeDefined();
    expect(final.ledger.filter((e) => e.stage === "clips")).toHaveLength(4);
  });

  it("a clip reroll cascades down the chain and stops at the next cut", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1, 1, 1], shots: ["cut", "continue", "continue", "cut"] });
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.submits).toHaveLength(2);
    expect(fakes.video.submits).toHaveLength(4);

    bumpNonce(ctx.manifest, 2, "clips");
    const plan = await planRun(ctx, STAGES);
    expect(plan.items.filter((i) => i.costUsd > 0).map((i) => [i.stage, i.scene])).toEqual([
      ["clips", 1],
      ["clips", 2],
    ]);

    const confirm = vi.fn(async () => true);
    await runPipeline(ctx, STAGES, { budgetUsd: 100, confirm, reroll: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fakes.video.submits.slice(4).map((c) => basename(c.imagePath))).toEqual(["seam_01.png", "seam_02.png"]);
    expect(fakes.image.submits).toHaveLength(2);
    expect(fakes.tts.calls).toHaveLength(4);
  });

  it("starts a continuing clip from exactly the last frame viewers see of the previous fitted clip", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1], shots: ["cut", "continue"] });
    await runPipeline(ctx, STAGES, auto);
    expect(ctx.manifest.scenes[0].fitted?.plan.kind).toBe("trim"); // 5 s clip cut to ~2.6 s of audio

    const sent = fakes.video.submits[1].imagePath;
    expect(sent).toBe(abs(ctx, paths.seam(0)));
    const shown = abs(ctx, "shown.png");
    await extractLastFrame(abs(ctx, paths.fitted(0)), shown);
    expect(await frameDiff(sent, shown)).toBe(0);
    // the raw clip's last frame, which viewers never see, is not what scene 2 starts from
    const rawLast = abs(ctx, "raw_last.png");
    await extractLastFrame(abs(ctx, paths.clip(0)), rawLast);
    expect(await frameDiff(rawLast, shown)).toBeGreaterThan(0);
    // chain.png's right column is the fitted last frame too
    expect(await frameDiff(abs(ctx, paths.lastFrame(0)), shown)).toBe(0);
  });

  it("the media checkpoint estimate equals what the ledger records", async () => {
    const plans: Array<[string, Plan]> = [];
    const { ctx } = await makeTestContext({ modes: [1, 2, 1] });
    await runPipeline(ctx, STAGES, { ...auto, onPlan: (p, label) => plans.push([label, p]) });
    const media = plans.find(([label]) => label === "Media plan")![1];
    const spent = ctx.manifest.ledger
      .filter((e) => e.stage === "keyframes" || e.stage === "clips")
      .reduce((a, e) => a + e.usd, 0);
    expect(spent).toBeCloseTo(media.totalUsd, 6);
    expect(media.totalUsd).toBeGreaterThan(0);
  });
});

describe("the spend cap (capUsd)", () => {
  // Still-image scenes whose narration has far more characters than the first checkpoint's guess: the voiceovers
  // cost more than first planned, so the first plan fits a cap that the voiceovers plus the media plan do not.
  const long = Array.from({ length: 16 }, (_, i) => `extraordinarily${i}`).join(" ");
  const script = () => {
    const s = fakeScript(2);
    return { ...s, scenes: s.scenes.map((scene) => ({ ...scene, narration: `${long}.` })) };
  };
  const stills = { modes: [2, 2] as Mode[], script };
  const sum = (ledger: Array<{ usd: number }>) => ledger.reduce((a, e) => a + e.usd, 0);

  it("stops at the media checkpoint when what was bought plus what remains is over the cap", async () => {
    const { ctx, fakes } = await makeTestContext(stills);
    const first = await planRun(ctx, STAGES);
    const plans: Array<[string, Plan]> = [];
    const confirm = vi.fn(async () => true);
    const run = runPipeline(ctx, STAGES, {
      budgetUsd: 100, confirm, yes: true, capUsd: first.totalUsd, onPlan: (p, label) => plans.push([label, p]),
    });
    await expect(run).rejects.toBeInstanceOf(RunAborted);
    await expect(run).rejects.toThrow(
      /^Run stopped: \$\d+\.\d{2} spent by this command plus \$\d+\.\d{2} still planned is over the \$\d+\.\d{2} cap\.$/,
    );
    expect(plans.map(([label]) => label)).toEqual(["Plan", "Media plan"]);
    expect(confirm).not.toHaveBeenCalled();

    // nothing after the checkpoint was bought, and the ledger holds only what was bought before it
    expect(fakes.image.submits).toHaveLength(0);
    expect(fakes.video.submits).toHaveLength(0);
    const saved = await loadManifest(ctx.dir);
    expect([...new Set(saved.ledger.map((e) => e.stage))].sort()).toEqual(["script", "tts"]);
    expect(fakes.tts.calls).toHaveLength(2);
    expect(sum(saved.ledger) + plans[1][1].totalUsd).toBeGreaterThan(first.totalUsd);
    expect(saved.final).toBeUndefined();
  });

  it("completes without a cap as before, and with a cap that covers everything the command spends", async () => {
    const probe = await makeTestContext(stills);
    await runPipeline(probe.ctx, STAGES, auto);
    expect(probe.ctx.manifest.final).toBeDefined();
    const total = Math.round(sum(probe.ctx.manifest.ledger) * 10_000) / 10_000;

    const { ctx } = await makeTestContext(stills);
    await runPipeline(ctx, STAGES, { ...auto, capUsd: total });
    expect((await loadManifest(ctx.dir)).final).toBeDefined();
    expect(sum(ctx.manifest.ledger)).toBeCloseTo(total, 6);
  });

  it("counts only what this command spends, not what the run spent before", async () => {
    const { ctx, fakes } = await makeTestContext({ modes: [1, 1] });
    await runPipeline(ctx, STAGES, auto);
    bumpNonce(ctx.manifest, 2, "clips");
    const plan = await planRun(ctx, STAGES);
    expect(plan.totalUsd).toBeGreaterThan(0);
    await runPipeline(ctx, STAGES, { ...auto, capUsd: plan.totalUsd });
    expect(fakes.video.submits).toHaveLength(3);
  });

  it("stops at the first checkpoint when the plan alone is over the cap, even with yes", async () => {
    const { ctx, fakes } = await makeTestContext(stills);
    const first = await planRun(ctx, STAGES);
    await expect(
      runPipeline(ctx, STAGES, { ...auto, yes: true, capUsd: first.totalUsd - 0.01 }),
    ).rejects.toBeInstanceOf(RunAborted);
    expect(fakes.llm.calls).toHaveLength(0);
    expect(ctx.manifest.ledger).toHaveLength(0);
  });
});
