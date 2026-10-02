import { existsSync } from "node:fs";
import { fileSha256 } from "../manifest/hash.js";
import { concatAudio, concatVideos, finalize } from "../media/assemble.js";
import { cellSize, contactSheet } from "../media/contact-sheet.js";
import { extractFrame, extractLastFrame } from "../media/frames.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip, requireFitted } from "./require.js";
import type { Stage, StageContext } from "./types.js";

const shaAll = (ctx: StageContext, rels: string[]) => Promise.all(rels.map((r) => fileSha256(abs(ctx, r))));

/** chain.png: first and last frame of every raw clip, one row per scene. */
async function writeChainSheet(ctx: StageContext): Promise<void> {
  const rows = [];
  for (const scene of ctx.manifest.scenes) {
    const clip = abs(ctx, requireClip(scene).path);
    const first = await outPath(ctx, paths.firstFrame(scene.idx));
    const last = abs(ctx, paths.lastFrame(scene.idx));
    await extractFrame(clip, 0, first);
    if (scene.mode === 2 || !existsSync(last)) await extractLastFrame(clip, await outPath(ctx, paths.lastFrame(scene.idx)));
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
    return 0;
  },
};
