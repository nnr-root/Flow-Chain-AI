/**
 * npm run voice:deploy [-- --yes]: creates or updates the studio's own voice on RunPod — a template and an
 * endpoint — and writes the endpoint's id into .env (phase 5 spec §6.1). From then on new runs are spoken there.
 * It costs nothing while nobody uses it (no worker runs, and it has no volume).
 */
import { createInterface } from "node:readline/promises";
import { execa } from "execa";
import { applyVoiceDeploy, assertImageInGhcr, planVoiceDeploy, RunpodRest, VOICE_DEFAULTS, voiceImageTag, writeEnvValues } from "../src/deploy/runpod.js";

async function defaultImage(): Promise<string> {
  const { stdout } = await execa("git", ["remote", "get-url", "origin"]);
  const owner = /github\.com[:/]([^/]+)\//.exec(stdout)?.[1];
  if (!owner) throw new Error("cannot tell the GitHub owner from the origin remote; set RUNPOD_VOICE_IMAGE");
  // the tag follows the content of worker-voice/, so the template always points at the image built from this checkout
  const tree = (await execa("git", ["rev-parse", "HEAD:worker-voice"])).stdout.trim();
  return `ghcr.io/${owner.toLowerCase()}/flowchain-voice:${voiceImageTag(tree)}`;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // rely on the real environment
  }
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) throw new Error("RUNPOD_API_KEY is not set (see README, \"The GPU worker\")");
  const cfg = { image: process.env.RUNPOD_VOICE_IMAGE ?? (await defaultImage()), gpus: VOICE_DEFAULTS.gpus };
  await assertImageInGhcr(cfg.image, console.warn); // before anything is created
  const rest = new RunpodRest(apiKey);
  console.log(`Voice deploy (image ${cfg.image}):`);
  for (const s of await planVoiceDeploy(rest)) console.log(`  ${s.action.padEnd(6)} ${s.what} ${s.name}`);
  console.log("Costs: nothing while idle (no worker runs and there is no volume); GPU seconds while a line is spoken.");
  if (!process.argv.includes("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Proceed? [y/N] ")).trim();
    rl.close();
    if (!/^y(es)?$/i.test(answer)) {
      console.log("Nothing was created.");
      return;
    }
  }
  const deployed = await applyVoiceDeploy(rest, cfg);
  await writeEnvValues(".env", { RUNPOD_VOICE_ENDPOINT: deployed.endpointId });
  console.log(`Wrote RUNPOD_VOICE_ENDPOINT=${deployed.endpointId} to .env: new runs are spoken by the studio's own voice.`);
  console.log("Next: npm run flowchain -- doctor, then a paid run to hear it (npm run smoke:runpod).");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
