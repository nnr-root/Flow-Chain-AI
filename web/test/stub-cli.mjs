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
  const file = args.includes("--reroll") ? "_plan-reroll.json" : args.includes("--modes") ? "_plan-modes.json" : args.includes("--translate") ? "_plan-translate.json" : "_plan.json";
  console.log(JSON.stringify(readJson(file, readJson("_plan.json", { items: [], totalUsd: 0 }))));
} else if (command === "ideas") {
  // topic ideas (phase 13): one answer after IDEAS_DELAY_MS, or a failure when FAIL_IDEAS is set
  if (process.env.IDEAS_DELAY_MS) await new Promise((done) => setTimeout(done, Number(process.env.IDEAS_DELAY_MS)));
  if (process.env.FAIL_IDEAS) {
    console.error("Error: the stub's model call failed");
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ideas: [{ topic: "A topic the stub made up", why: "Because a test asked", sources: [] }], dropped: 0 }));
  }
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
} else if (command === "translate") {
  // a version (phase 8 spec §4): the new run's manifest is its source's, in the new language
  const id = flag("--run-id");
  const source = JSON.parse(readFileSync(join(runs, args[1], "manifest.json"), "utf8"));
  mkdirSync(join(runs, id), { recursive: true });
  const request = { ...source.request, language: flag("--language"), voiceId: flag("--voice"), versionOf: { runId: args[1], title: "t", hook: "h", narrations: ["n"], seconds: [1] } };
  const spent = readJson("_behave.json", {}).spendUsd;
  writeFileSync(join(runs, id, "manifest.json"), JSON.stringify({ ...source, runId: id, request, ledger: spent ? [{ stage: "tts", scene: 0, usd: spent, at: new Date().toISOString() }] : [] }));
  console.log(`Run ${id}`);
} else {
  // resume, reroll, rerender: wait if asked (so a test can observe "running"), then end as asked
  console.log(`▶ ${command}`);
  // the real pipeline's output names what it calls; the studio must keep those words from a customer
  console.log("ElevenLabs voice ok; RunPod endpoint ab12cd34 healthy");
  const behave = readJson("_behave.json", {});
  // which of the server's own secrets reached this process (none should)
  if (behave.envNames) writeFileSync(join(runs, "_env.json"), JSON.stringify(Object.keys(process.env).filter((name) => /^(DATABASE_URL|REDIS_URL|SMTP_URL|MAIL_|GOOGLE_|WORKER_)/.test(name))));
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
  // "finishes" the video: the file a finished run has
  if (behave.makesVideo && command === "resume" && existsSync(join(runs, args[1]))) writeFileSync(join(runs, args[1], "final.mp4"), "video");
  process.exitCode = behave.exitCode ?? 0;
}
