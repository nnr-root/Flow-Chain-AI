import type { Manifest, StageName, StageRecord } from "./manifest/schema.js";
import { needsKeyframe } from "./stages/visual.js";

const mark = (r?: StageRecord) => (r === undefined ? "·" : r.status === "done" ? "✓" : "✗");
const RUN_STAGES: StageName[] = ["script", "captions", "render"];
const SCENE_STAGES: StageName[] = ["tts", "silence", "keyframes", "clips", "fit"];

export function formatStatus(m: Manifest): string {
  const { request: r, models } = m;
  const lines = [
    `Run ${m.runId} — ${r.aspect}, ${r.sceneCount} scenes, modes ${r.modes.join(",")}`,
    `Topic: ${r.topic}`,
    `Models: llm ${models.llm} · tts ${models.tts} · image ${models.image} · video ${models.video}`,
    `Run stages: ${RUN_STAGES.map((s) => `${s} ${mark(m.runStages[s])}`).join("  ")}`,
  ];
  for (const st of RUN_STAGES) {
    const rec = m.runStages[st];
    if (rec?.status === "failed") lines.push(`  error in ${st}: ${rec.error}`);
  }
  for (const scene of m.scenes) {
    // keyframes only where the scene has one; clips and fit only for Mode 1 (Mode 2 is animated at render time)
    const shown = SCENE_STAGES.filter(
      (s) => (s !== "keyframes" || needsKeyframe(m, scene.idx)) && ((s !== "clips" && s !== "fit") || scene.mode === 1),
    );
    lines.push(`Scene ${scene.idx + 1} [mode ${scene.mode}]: ${shown.map((s) => `${s} ${mark(scene.stages[s])}`).join("  ")}`);
    for (const st of SCENE_STAGES) {
      const rec = scene.stages[st];
      if (rec?.status === "failed") lines.push(`  error in ${st}: ${rec.error}`);
    }
  }
  const spend = m.ledger.reduce((sum, e) => sum + e.usd, 0);
  lines.push(
    `Spend (estimated from the price table, not invoices): $${spend.toFixed(2)} across ${m.ledger.length} paid call(s)`,
  );
  if (m.final) lines.push(`Final: ${m.final.path} (${m.final.duration.toFixed(2)} s) · chain sheet: ${m.final.chain}`);
  return lines.join("\n");
}
