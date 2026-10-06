import { readFile, writeFile } from "node:fs/promises";
import { HttpError } from "../providers/retry.js";
import type { RunpodClient } from "../providers/runpod.js";

export const NAMES = {
  volume: "flowchain-models",
  template: "flowchain-worker",
  keyframe: "flowchain-keyframe",
  clip: "flowchain-clip",
} as const;

/** Secrets hold the R2 keys; the template env refers to them, so they never sit in plain text on RunPod. */
export const SECRET_NAMES = { accessKeyId: "flowchain_r2_access_key_id", secretAccessKey: "flowchain_r2_secret_access_key" };

export type DeployConfig = {
  image: string;
  dataCenterId: string;
  volumeGb: number;
  keyframeGpus: string[];
  clipGpus: string[];
  r2: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };
};

export const DEFAULTS = {
  dataCenterId: "EU-RO-1",
  volumeGb: 80,
  keyframeGpus: ["NVIDIA GeForce RTX 4090"],
  clipGpus: ["NVIDIA L40S"],
  /** Network volume storage, $ per GB per month (RunPod standard tier). */
  volumeUsdPerGbMonth: 0.07,
};

type Kind = "networkvolumes" | "templates" | "endpoints";
type Resource = { id: string; name: string };

/** RunPod's REST API v1 (https://rest.runpod.io/v1) plus the v2 secrets endpoint. */
export class RunpodRest {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = "https://rest.runpod.io/v1",
    private readonly secretsUrl = "https://api.runpod.io/v2/account/secrets",
  ) {}

  private async call(method: string, url: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private static async json<T>(what: string, res: Response): Promise<T> {
    if (!res.ok) throw new HttpError(`RunPod ${what} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
    return (await res.json()) as T;
  }

  async list(kind: Kind): Promise<Resource[]> {
    return RunpodRest.json(`list ${kind}`, await this.call("GET", `${this.base}/${kind}`));
  }

  async create(kind: Kind, body: Record<string, unknown>): Promise<Resource> {
    return RunpodRest.json(`create ${kind}`, await this.call("POST", `${this.base}/${kind}`, body));
  }

  async update(kind: Kind, id: string, body: Record<string, unknown>): Promise<Resource> {
    return RunpodRest.json(`update ${kind} ${id}`, await this.call("PATCH", `${this.base}/${kind}/${id}`, body));
  }

  /** Creates a secret; false when one with that name already exists (values cannot be changed through the API). */
  async createSecret(name: string, value: string): Promise<boolean> {
    const res = await this.call("POST", this.secretsUrl, { name, value });
    if (res.status === 409) return false;
    await RunpodRest.json(`create secret ${name}`, res);
    return true;
  }
}

export type Step = { what: string; name: string; action: "create" | "update" };

/** What a deploy will do, given what already exists (matched by name). */
export async function planDeploy(rest: RunpodRest): Promise<Step[]> {
  const [volumes, templates, endpoints] = await Promise.all([
    rest.list("networkvolumes"),
    rest.list("templates"),
    rest.list("endpoints"),
  ]);
  const has = (list: Resource[], name: string) => list.some((r) => r.name === name);
  const step = (what: string, list: Resource[], name: string): Step => ({ what, name, action: has(list, name) ? "update" : "create" });
  return [
    step("network volume", volumes, NAMES.volume),
    step("template", templates, NAMES.template),
    step("endpoint", endpoints, NAMES.keyframe),
    step("endpoint", endpoints, NAMES.clip),
  ];
}

export type Deployed = { volumeId: string; templateId: string; keyframeEndpointId: string; clipEndpointId: string };

async function upsert(rest: RunpodRest, kind: Kind, name: string, body: Record<string, unknown>, update: Record<string, unknown>) {
  const found = (await rest.list(kind)).find((r) => r.name === name);
  return found ? rest.update(kind, found.id, update) : rest.create(kind, { name, ...body });
}

/** Creates or updates the volume, template and both endpoints; returns their ids. Safe to re-run. */
export async function applyDeploy(rest: RunpodRest, cfg: DeployConfig, log: (m: string) => void): Promise<Deployed> {
  for (const [key, value] of [
    [SECRET_NAMES.accessKeyId, cfg.r2.accessKeyId],
    [SECRET_NAMES.secretAccessKey, cfg.r2.secretAccessKey],
  ] as const) {
    if (!(await rest.createSecret(key, value))) log(`secret ${key} already exists (kept; delete it on RunPod to change it)`);
  }
  // a volume can grow but never shrink, and stays in its data centre
  const volume = await upsert(
    rest,
    "networkvolumes",
    NAMES.volume,
    { size: cfg.volumeGb, dataCenterId: cfg.dataCenterId },
    { size: cfg.volumeGb },
  );
  const env = {
    R2_ACCOUNT_ID: cfg.r2.accountId,
    R2_BUCKET: cfg.r2.bucket,
    R2_ACCESS_KEY_ID: `{{ RUNPOD_SECRET_${SECRET_NAMES.accessKeyId} }}`,
    R2_SECRET_ACCESS_KEY: `{{ RUNPOD_SECRET_${SECRET_NAMES.secretAccessKey} }}`,
  };
  const templateBody = { imageName: cfg.image, containerDiskInGb: 30, env };
  const template = await upsert(rest, "templates", NAMES.template, { ...templateBody, isServerless: true }, templateBody);
  const endpoint = (gpus: string[], executionTimeoutMs: number) => ({
    templateId: template.id,
    gpuTypeIds: gpus,
    workersMin: 0,
    workersMax: 2,
    idleTimeout: 5,
    executionTimeoutMs,
    flashboot: true,
    networkVolumeId: volume.id,
    dataCenterIds: [cfg.dataCenterId],
  });
  const keyframe = endpoint(cfg.keyframeGpus, 120_000);
  const clip = endpoint(cfg.clipGpus, 600_000);
  const keyframeEndpoint = await upsert(rest, "endpoints", NAMES.keyframe, keyframe, keyframe);
  const clipEndpoint = await upsert(rest, "endpoints", NAMES.clip, clip, clip);
  return { volumeId: volume.id, templateId: template.id, keyframeEndpointId: keyframeEndpoint.id, clipEndpointId: clipEndpoint.id };
}

/**
 * Runs the worker's `fetch-models` task on an endpoint and waits for it. Its own policy lets it run longer than
 * the endpoint's normal job limit (the first download is tens of GB).
 */
export async function fetchModels(
  client: RunpodClient,
  endpointId: string,
  only: "keyframe" | "clip",
  opts: { pollMs?: number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): Promise<{ downloaded: string[]; skipped: string[] }> {
  const { pollMs = 15_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 3 * 3_600_000 } = opts;
  const id = await client.run(endpointId, { task: "fetch-models", only }, { executionTimeout: timeoutMs, ttl: timeoutMs + 3_600_000 }, new AbortController().signal);
  for (let waited = 0; waited <= timeoutMs + 3_600_000; waited += pollMs) {
    const job = await client.status(endpointId, id);
    if (job?.status === "COMPLETED") return job.output as { downloaded: string[]; skipped: string[] };
    if (job === null || job.status === "FAILED" || job.status === "CANCELLED" || job.status === "TIMED_OUT") {
      throw new Error(`fetch-models on ${endpointId} ended ${job?.status ?? "unknown"}: ${JSON.stringify(job?.error ?? null)}`);
    }
    await sleep(pollMs);
  }
  throw new Error(`fetch-models on ${endpointId} did not finish`);
}

/** Sets KEY=value lines in a .env file, replacing existing ones and appending new ones. */
export async function writeEnvValues(path: string, values: Record<string, string>): Promise<void> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    // no .env yet
  }
  const lines = text.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  await writeFile(path, `${lines.join("\n")}\n`);
}
