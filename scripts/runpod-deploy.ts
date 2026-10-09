/**
 * npm run runpod:deploy [-- --yes]: creates or updates the RunPod volume, template and endpoints, seeds the model
 * weights and writes the endpoint ids into .env (2.4 spec §4.3). Asks before creating billable resources.
 */
import { createInterface } from "node:readline/promises";
import { execa } from "execa";
import {
  applyDeploy, assertImageInGhcr, DEFAULTS, fetchModels, planDeploy, RunpodRest, workerImageTag, writeEnvValues,
} from "../src/deploy/runpod.js";
import { RunpodClient } from "../src/providers/runpod.js";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see README "RunPod (self-hosted keyframes and clips)")`);
  return value;
}

async function defaultImage(): Promise<string> {
  const { stdout } = await execa("git", ["remote", "get-url", "origin"]);
  const owner = /github\.com[:/]([^/]+)\//.exec(stdout)?.[1];
  if (!owner) throw new Error("cannot tell the GitHub owner from the origin remote; set RUNPOD_WORKER_IMAGE");
  // the tag follows the content of workers/, so a template always points at the image built from this checkout
  const tree = (await execa("git", ["rev-parse", "HEAD:workers"])).stdout.trim();
  return `ghcr.io/${owner.toLowerCase()}/flowchain-worker:${workerImageTag(tree)}`;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // rely on the real environment
  }
  const apiKey = need("RUNPOD_API_KEY");
  const cfg = {
    image: process.env.RUNPOD_WORKER_IMAGE ?? (await defaultImage()),
    dataCenterId: process.env.RUNPOD_DATACENTER ?? DEFAULTS.dataCenterId,
    volumeGb: DEFAULTS.volumeGb,
    keyframeGpus: DEFAULTS.keyframeGpus,
    clipGpus: DEFAULTS.clipGpus,
    r2: {
      accountId: need("R2_ACCOUNT_ID"),
      bucket: need("R2_BUCKET"),
      accessKeyId: need("R2_ACCESS_KEY_ID"),
      secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
    },
  };
  await assertImageInGhcr(cfg.image, console.warn); // before anything is created
  const rest = new RunpodRest(apiKey);
  const steps = await planDeploy(rest);
  console.log(`RunPod deploy (image ${cfg.image}, data centre ${cfg.dataCenterId}):`);
  for (const s of steps) console.log(`  ${s.action.padEnd(6)} ${s.what} ${s.name}`);
  const monthly = cfg.volumeGb * DEFAULTS.volumeUsdPerGbMonth;
  console.log(`Costs: the ${cfg.volumeGb} GB volume ≈ $${monthly.toFixed(2)}/month; the one-time model download runs on`);
  console.log("each endpoint's GPU (≈ $1–2); idle endpoints cost nothing (0 workers when unused).");
  if (!process.argv.includes("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Proceed? [y/N] ")).trim();
    rl.close();
    if (!/^y(es)?$/i.test(answer)) {
      console.log("Nothing was created.");
      return;
    }
  }
  const deployed = await applyDeploy(rest, cfg, console.log);
  console.log(`Endpoints: keyframe ${deployed.keyframeEndpointId}, clip ${deployed.clipEndpointId}`);
  // saved before the long model downloads, so a failed download never loses the ids of what was just created
  await writeEnvValues(".env", {
    RUNPOD_KEYFRAME_ENDPOINT: deployed.keyframeEndpointId,
    RUNPOD_CLIP_ENDPOINT: deployed.clipEndpointId,
  });
  console.log("Wrote RUNPOD_KEYFRAME_ENDPOINT and RUNPOD_CLIP_ENDPOINT to .env.");
  const client = new RunpodClient(apiKey);
  for (const [kind, id] of [["keyframe", deployed.keyframeEndpointId], ["clip", deployed.clipEndpointId]] as const) {
    console.log(`Fetching ${kind} model weights onto the volume (the first time takes a while)…`);
    const done = await fetchModels(client, id, kind);
    console.log(`  downloaded ${done.downloaded.length}, already present ${done.skipped.length}`);
  }
  console.log("Next: npm run flowchain -- doctor, then npm run smoke:runpod (paid).");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
