/**
 * npm run eval:cuts -- <runWithReferences> <runWithout> [--runs <dir>]
 *
 * FREE (phase 10 spec §7): compares two finished runs of the same script and seed, one made with FLOWCHAIN_CUT_REFERENCES=on
 * and one with off, by how alike their keyframes look and by how many keyframes were made again. It reads files and
 * calls ffmpeg; it calls no provider. The owner makes the two runs (that is the paid part) and decides from this.
 */
import { join } from "node:path";
import { consistency, keyframeLook } from "../src/eval/look.js";
import { loadManifest } from "../src/manifest/store.js";

async function summary(runs: string, id: string) {
  const dir = join(runs, id);
  const m = await loadManifest(dir);
  const files = m.scenes.flatMap((s) => (s.keyframe ? [join(dir, s.keyframe.path)] : []));
  const looks = await Promise.all(files.map(keyframeLook));
  const remade = m.scenes.reduce((n, s) => n + (s.remade?.keyframes?.count ?? 0), 0);
  return { id, keyframes: files.length, consistency: consistency(looks), remade, profile: m.request.imageProfile, cutReferences: m.request.cutReferences === true };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--runs");
  const runs = at >= 0 ? argv[at + 1] : (process.env.RUNS_DIR ?? "./runs");
  const ids = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--runs");
  if (ids.length !== 2) {
    console.error("usage: npm run eval:cuts -- <runWithReferences> <runWithout> [--runs <dir>]");
    process.exit(1);
  }
  const [withRefs, without] = await Promise.all(ids.map((id) => summary(runs, id)));
  if (!withRefs.cutReferences || without.cutReferences) {
    console.error(`the first run must have been made with cut references on and the second with them off (found: ${withRefs.cutReferences}, ${without.cutReferences})`);
    process.exit(1);
  }
  for (const r of [withRefs, without]) console.log(`${r.id}: ${r.keyframes} keyframes, look distance between neighbours ${r.consistency.toFixed(4)} (lower is more alike), ${r.remade} made again, profile ${r.profile}`);
  const better = withRefs.consistency < without.consistency;
  const cleaner = withRefs.remade <= without.remade;
  console.log(better && cleaner ? "References look better and no worse in faults: set FLOWCHAIN_CUT_REFERENCES=on." : "References did not clearly win: keep FLOWCHAIN_CUT_REFERENCES=off, or make more runs.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
