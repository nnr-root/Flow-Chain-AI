import { fileSha256 } from "../manifest/hash.js";
import { concatAudio, concatVideos, finalize } from "../media/assemble.js";
import { cellSize, contactSheet } from "../media/contact-sheet.js";
import { extractFrame, extractLastFrame } from "../media/frames.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip, requireFitted } from "./require.js";
import type { Stage, StageContext } from "./types.js";

const shaAll = (ctx: StageContext, rels: string[]) => Promise.all(rels.map((r) => fileSha256(abs(ctx, r))));

/**
 * chain.png: one row per scene, [first frame of the raw clip | last frame of the fitted clip]. The right
 * column is what viewers see at each seam, so row N's right cell vs row N+1's left cell shows the drift
 * of a continuing scene.
 */
async function writeChainSheet(ctx: StageContext): Promise<void> {
  const rows = [];
  for (const scene of ctx.manifest.scenes) {
    const first = await outPath(ctx, paths.firstFrame(scene.idx));
    const last = await outPath(ctx, paths.lastFrame(scene.idx));
    await extractFrame(abs(ctx, requireClip(scene).path), 0, first);
    await extractLastFrame(abs(ctx, requireFitted(scene).path), last);
    rows.push({ first, last });
  }
  await contactSheet(rows, abs(ctx, paths.chain), cellSize(ctx.size));
}

export const assembleStage: Stage = {
  name: "assemble",
  perScene: false,
  paid: false,
  deps: (m) => [{ stage: "captions" }, ...m.scenes.map((s) => ({ stage: "fit" as const, scene: s.idx }))],
  async inputsFor(ctx) {
    const m = ctx.manifest;
    return {
      fitted: await shaAll(ctx, m.scenes.map((s) => requireFitted(s).path)),
      audio: await shaAll(ctx, m.scenes.map((s) => requireAudio(s).path)),
      clips: await shaAll(ctx, m.scenes.map((s) => requireClip(s).path)),
      captions: await fileSha256(abs(ctx, paths.captions)),
      bgm: m.request.bgm ? await fileSha256(m.request.bgm) : null,
    };
  },
  outputsFor: () => [paths.final, paths.chain],
  estimateCostUsd: () => 0,
  async run(ctx) {
    const m = ctx.manifest;
    const totalFrames = m.scenes.reduce((sum, s) => sum + requireFitted(s).frames, 0);
    const video = await outPath(ctx, paths.video);
    const narration = await outPath(ctx, paths.narration);
    await concatVideos(m.scenes.map((s) => abs(ctx, requireFitted(s).path)), video);
    await concatAudio(m.scenes.map((s) => abs(ctx, requireAudio(s).path)), narration);
    await finalize({
      video,
      narration,
      captions: abs(ctx, paths.captions),
      fontsDir: ctx.fontsDir,
      bgm: m.request.bgm,
      totalFrames,
      fps: ctx.fps,
      out: abs(ctx, paths.final),
    });
    await writeChainSheet(ctx);
    m.final = { path: paths.final, duration: totalFrames / ctx.fps, captions: paths.captions, chain: paths.chain };
  },
};
