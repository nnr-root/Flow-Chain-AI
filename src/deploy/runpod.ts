import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
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
  // 24 GB: Wan 2.2 fp8 loads one expert at a time; no 48 GB card was in stock in the volume's data centre (spec §16)
  clipGpus: ["NVIDIA GeForce RTX 4090"],
  /** Network volume storage, $ per GB per month (RunPod standard tier). */
  volumeUsdPerGbMonth: 0.07,
};

type Kind = "networkvolumes" | "templates" | "endpoints";
type Resource = { id: string; name: string; size?: number; dataCenterId?: string };

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
    // templates bound to an endpoint (ours always are) are hidden from the list unless asked for
    const query = kind === "templates" ? "?includeEndpointBoundTemplates=true" : "";
    return RunpodRest.json(`list ${kind}`, await this.call("GET", `${this.base}/${kind}${query}`));
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

/** The one match for a name; RunPod may show a FlashBoot endpoint as "<name> -fb". Throws when the name is ambiguous. */
function findByName(list: Resource[], kind: Kind, name: string): Resource | undefined {
  const matches = list.filter((r) => r.name.replace(/ -fb$/, "") === name);
  if (matches.length > 1) {
    throw new Error(`RunPod has ${matches.length} ${kind} named "${name}" (ids ${matches.map((r) => r.id).join(", ")}); delete the extras and re-run`);
  }
  return matches[0];
}

export type Step = { what: string; name: string; action: "create" | "update" };

type Existing = { volume?: Resource; template?: Resource; keyframe?: Resource; clip?: Resource };

/** What RunPod already has for our four resources (matched by name); throws when a name is ambiguous. Read-only. */
async function lookupExisting(rest: RunpodRest): Promise<Existing> {
  const [volumes, templates, endpoints] = await Promise.all([
    rest.list("networkvolumes"),
    rest.list("templates"),
    rest.list("endpoints"),
  ]);
  return {
    volume: findByName(volumes, "networkvolumes", NAMES.volume),
    template: findByName(templates, "templates", NAMES.template),
    keyframe: findByName(endpoints, "endpoints", NAMES.keyframe),
    clip: findByName(endpoints, "endpoints", NAMES.clip),
  };
}

/** What a deploy will do, given what already exists (matched by name). */
export async function planDeploy(rest: RunpodRest): Promise<Step[]> {
  const found = await lookupExisting(rest);
  const step = (what: string, existing: Resource | undefined, name: string): Step => ({
    what,
    name,
    action: existing ? "update" : "create",
  });
  return [
    step("network volume", found.volume, NAMES.volume),
    step("template", found.template, NAMES.template),
    step("endpoint", found.keyframe, NAMES.keyframe),
    step("endpoint", found.clip, NAMES.clip),
  ];
}

export type Deployed = { volumeId: string; templateId: string; keyframeEndpointId: string; clipEndpointId: string };

async function upsert(
  rest: RunpodRest,
  kind: Kind,
  found: Resource | undefined,
  name: string,
  body: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  return found ? rest.update(kind, found.id, update) : rest.create(kind, { name, ...body });
}

/** Creates or updates the volume, template and both endpoints; returns their ids. Safe to re-run. */
export async function applyDeploy(rest: RunpodRest, cfg: DeployConfig, log: (m: string) => void): Promise<Deployed> {
  // every lookup and check comes before the first write, so an ambiguous or unusable setup changes nothing
  const existing = await lookupExisting(rest);
  const { volume: oldVolume } = existing;
  if (oldVolume?.dataCenterId !== undefined && oldVolume.dataCenterId !== cfg.dataCenterId) {
    throw new Error(
      `network volume ${NAMES.volume} lives in ${oldVolume.dataCenterId}, not ${cfg.dataCenterId}; a volume cannot move ` +
        `(set RUNPOD_DATACENTER=${oldVolume.dataCenterId}, or delete the volume on RunPod and re-run)`,
    );
  }
  for (const [key, value] of [
    [SECRET_NAMES.accessKeyId, cfg.r2.accessKeyId],
    [SECRET_NAMES.secretAccessKey, cfg.r2.secretAccessKey],
  ] as const) {
    if (!(await rest.createSecret(key, value))) log(`secret ${key} already exists (kept; delete it on RunPod to change it)`);
  }
  // a volume can grow but never shrink, and stays in its data centre
  const volume =
    oldVolume && (oldVolume.size ?? 0) >= cfg.volumeGb
      ? oldVolume
      : await upsert(
          rest,
          "networkvolumes",
          oldVolume,
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
  const template = await upsert(rest, "templates", existing.template, NAMES.template, { ...templateBody, isServerless: true }, templateBody);
  const endpoint = (gpus: string[], executionTimeoutMs: number) => ({
    templateId: template.id,
    gpuTypeIds: gpus,
    workersMin: 0,
    // one worker: a run's jobs are sequential, and a second worker loads the model weights again for itself
    // (3.1 spec §16: clips alternated between two workers and each cost a cold start)
    workersMax: 1,
    idleTimeout: 30, // seconds: keeps the worker warm between a run's sequential jobs
    executionTimeoutMs,
    flashboot: true,
    networkVolumeId: volume.id,
    dataCenterIds: [cfg.dataCenterId],
  });
  const keyframe = endpoint(cfg.keyframeGpus, 120_000);
  const clip = endpoint(cfg.clipGpus, 600_000);
  const keyframeEndpoint = await upsert(rest, "endpoints", existing.keyframe, NAMES.keyframe, keyframe, keyframe);
  const clipEndpoint = await upsert(rest, "endpoints", existing.clip, NAMES.clip, clip, clip);
  return { volumeId: volume.id, templateId: template.id, keyframeEndpointId: keyframeEndpoint.id, clipEndpointId: clipEndpoint.id };
}

/**
 * Runs the worker's `fetch-models` task on an endpoint and waits for it. Its own policy lets it run longer than
 * the endpoint's normal job limit (the first download is tens of GB; capped at 1 h so a stuck download cannot bill for hours).
 */
export async function fetchModels(
  client: RunpodClient,
  endpointId: string,
  only: "keyframe" | "clip",
  opts: { pollMs?: number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
): Promise<{ downloaded: string[]; skipped: string[] }> {
  const { pollMs = 15_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 3_600_000 } = opts;
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
  // temp file in the same directory, then rename: a crash can never leave a half-written .env
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${lines.join("\n")}\n`);
  try {
    await chmod(temp, (await stat(path)).mode & 0o777);
  } catch {
    // no .env yet: keep the default mode
  }
  await rename(temp, path);
}

/** The immutable worker image tag for a tree hash of `workers/` (`git rev-parse HEAD:workers`); the workflow pushes the same tag. */
export function workerImageTag(workersTreeHash: string): string {
  return `w-${workersTreeHash.slice(0, 12)}`;
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

class ImageMissing extends Error {}

/**
 * Checks, anonymously, that a ghcr.io image exists and is public, so a deploy never points a template at an
 * image RunPod cannot pull. Throws when GHCR says it is missing or private; a network failure only warns.
 * Other registries are not checked.
 */
export async function assertImageInGhcr(
  image: string,
  warn: (m: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!image.startsWith("ghcr.io/")) return;
  const rest = image.slice("ghcr.io/".length);
  const at = rest.indexOf("@");
  const colon = rest.lastIndexOf(":");
  const [repo, reference] =
    at >= 0
      ? [rest.slice(0, at), rest.slice(at + 1)]
      : colon > rest.lastIndexOf("/")
        ? [rest.slice(0, colon), rest.slice(colon + 1)]
        : [rest, "latest"];
  const missing = () =>
    new ImageMissing(
      `image ${image} is not in GHCR or the package is not public: push \`main\`, wait for the worker-image Action, ` +
        "make the package public",
    );
  try {
    const tokenRes = await fetchImpl(`https://ghcr.io/token?scope=repository:${repo}:pull`);
    if ([401, 403, 404].includes(tokenRes.status)) throw missing();
    if (!tokenRes.ok) throw new Error(`token request answered HTTP ${tokenRes.status}`);
    const { token } = (await tokenRes.json()) as { token?: string };
    const res = await fetchImpl(`https://ghcr.io/v2/${repo}/manifests/${reference}`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
    });
    if ([401, 403, 404].includes(res.status)) throw missing();
    if (!res.ok) throw new Error(`manifest request answered HTTP ${res.status}`);
  } catch (err) {
    if (err instanceof ImageMissing) throw err;
    warn(`could not check that ${image} exists in GHCR (${err instanceof Error ? err.message : String(err)}); continuing`);
  }
}
