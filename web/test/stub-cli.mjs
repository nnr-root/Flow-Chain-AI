// A stand-in for the flowchain CLI in the studio's tests: it never reaches a provider. It records every call in
// <RUNS_DIR>/_calls.jsonl and behaves just enough like the real commands for the server code around it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const runs = process.env.RUNS_DIR;
const command = args[0];
appendFileSync(join(runs, "_calls.jsonl"), `${JSON.stringify(args)}\n`);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const readJson = (file, fallback) => (existsSync(join(runs, file)) ? JSON.parse(readFileSync(join(runs, file), "utf8")) : fallback);

if (command === "plan") {
  // _plan.json: what continuing costs; _plan-modes.json / _plan-reroll.json: what the tried-out variant costs
  const file = args.includes("--reroll") ? "_plan-reroll.json" : args.includes("--modes") ? "_plan-modes.json" : "_plan.json";
  console.log(JSON.stringify(readJson(file, readJson("_plan.json", { items: [], totalUsd: 0 }))));
} else if (command === "draft-modes") {
  console.log(JSON.stringify({ modes: [], reasons: [], estimatedUsd: 0 }));
} else if (command === "run") {
  // a draft: the fixture manifest becomes the new run's manifest
  const id = flag("--run-id");
  const manifest = readJson("_draft-manifest.json", null);
  if (manifest) {
    mkdirSync(join(runs, id), { recursive: true });
    writeFileSync(join(runs, id, "manifest.json"), JSON.stringify({ ...manifest, runId: id }));
  }
  console.log(`Run ${id}`);
} else {
  // resume, reroll, rerender: wait if asked (so a test can observe "running"), then end as asked
  console.log(`▶ ${command}`);
  const behave = readJson("_behave.json", {});
  // which of the server's own secrets reached this process (none should)
  if (behave.envNames) writeFileSync(join(runs, "_env.json"), JSON.stringify(Object.keys(process.env).filter((name) => /^SUPABASE_/.test(name))));
  // "submits" a provider job and then waits for it: stopped here, the job is submitted and never collected
  if (behave.pendingUsd && existsSync(join(runs, args[1], "manifest.json"))) {
    const file = join(runs, args[1], "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (behave.abandonedUsd) manifest.scenes[0].abandonedUsd = (manifest.scenes[0].abandonedUsd ?? 0) + behave.abandonedUsd;
    manifest.scenes[0].jobs = { ...manifest.scenes[0].jobs, clips: { requestId: "stub-request", inputHash: "stub", submittedAt: new Date().toISOString(), expectedUsd: behave.pendingUsd, chargedUsd: 0 } };
    writeFileSync(file, JSON.stringify(manifest));
  }
  if (behave.sleepMs) await new Promise((done) => setTimeout(done, behave.sleepMs));
  // "buys" something: the run's manifest records the spend, as the real pipeline's ledger does
  if (behave.spendUsd && existsSync(join(runs, args[1], "manifest.json"))) {
    const file = join(runs, args[1], "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest.ledger.push({ stage: "clips", scene: 1, usd: behave.spendUsd, at: new Date().toISOString() });
    writeFileSync(file, JSON.stringify(manifest));
  }
  process.exitCode = behave.exitCode ?? 0;
}
