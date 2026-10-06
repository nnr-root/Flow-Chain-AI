import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDeploy, assertImageInGhcr, DEFAULTS, fetchModels, NAMES, planDeploy, RunpodRest, workerImageTag, writeEnvValues,
} from "../../src/deploy/runpod.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { FakeRunpodApi } from "../fakes/runpod.js";
import { tempDir } from "../helpers/media.js";

/** RunPod's REST API in memory: resources by kind, and the requests made. */
function fakeRest() {
  const store: Record<string, Array<{ id: string; name: string } & Record<string, unknown>>> = {
    networkvolumes: [],
    templates: [],
    endpoints: [],
  };
  const secrets = new Set<string>();
  const calls: string[] = [];
  let n = 0;
  const fetchImpl = async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    calls.push(`${init.method} ${u.pathname}`);
    if (u.pathname.endsWith("/account/secrets")) {
      if (secrets.has(body.name)) return json(409, { error: "exists" });
      secrets.add(body.name);
      return json(201, { name: body.name });
    }
    const [, , kind, id] = u.pathname.split("/");
    if (init.method === "GET") {
      // like RunPod: a template an endpoint is bound to is hidden unless asked for
      if (kind === "templates" && u.searchParams.get("includeEndpointBoundTemplates") !== "true") {
        return json(200, store.templates.filter((t) => !store.endpoints.some((e) => e.templateId === t.id)));
      }
      return json(200, store[kind]);
    }
    if (init.method === "POST") {
      const r = { id: `${kind}-${++n}`, ...body };
      store[kind].push(r);
      return json(200, r);
    }
    const r = store[kind].find((x) => x.id === id)!;
    Object.assign(r, body);
    return json(200, r);
  };
  return { rest: new RunpodRest("key", fetchImpl as typeof fetch), store, secrets, calls };
}

const cfg = {
  image: "ghcr.io/me/flowchain-worker:latest",
  dataCenterId: "EU-RO-1",
  volumeGb: 80,
  keyframeGpus: DEFAULTS.keyframeGpus,
  clipGpus: DEFAULTS.clipGpus,
  r2: { accountId: "acc", bucket: "out", accessKeyId: "AK", secretAccessKey: "SK" },
};

describe("runpod deploy", () => {
  it("creates the volume, one template and both endpoints, with R2 keys as secrets", async () => {
    const { rest, store, secrets } = fakeRest();
    expect((await planDeploy(rest)).map((s) => `${s.action} ${s.name}`)).toEqual([
      "create flowchain-models",
      "create flowchain-worker",
      "create flowchain-keyframe",
      "create flowchain-clip",
    ]);
    const ids = await applyDeploy(rest, cfg, () => {});
    expect(store.networkvolumes[0]).toMatchObject({ name: NAMES.volume, size: 80, dataCenterId: "EU-RO-1" });
    expect(store.templates[0]).toMatchObject({
      name: NAMES.template,
      imageName: cfg.image,
      isServerless: true,
      env: { R2_ACCOUNT_ID: "acc", R2_BUCKET: "out", R2_ACCESS_KEY_ID: "{{ RUNPOD_SECRET_flowchain_r2_access_key_id }}" },
    });
    expect(store.endpoints.map((e) => [e.name, e.gpuTypeIds, e.executionTimeoutMs, e.workersMax, e.networkVolumeId])).toEqual([
      [NAMES.keyframe, ["NVIDIA GeForce RTX 4090"], 120_000, 2, ids.volumeId],
      [NAMES.clip, ["NVIDIA L40S", "NVIDIA L40", "NVIDIA RTX 6000 Ada Generation"], 600_000, 2, ids.volumeId],
    ]);
    expect([...secrets].sort()).toEqual(["flowchain_r2_access_key_id", "flowchain_r2_secret_access_key"]);
  });

  it("updates instead of duplicating on a second run, and keeps existing secrets", async () => {
    const { rest, store } = fakeRest();
    const first = await applyDeploy(rest, cfg, () => {});
    const logs: string[] = [];
    const second = await applyDeploy(rest, { ...cfg, image: "ghcr.io/me/flowchain-worker:abc123" }, (m) => logs.push(m));
    expect(second).toEqual(first);
    expect([store.networkvolumes.length, store.templates.length, store.endpoints.length]).toEqual([1, 1, 2]);
    expect(store.templates[0].imageName).toBe("ghcr.io/me/flowchain-worker:abc123");
    expect(logs).toContain("secret flowchain_r2_access_key_id already exists (kept; delete it on RunPod to change it)");
    expect((await planDeploy(rest)).every((s) => s.action === "update")).toBe(true);
  });

  it("treats an endpoint the API reports as '<name> -fb' as the same endpoint", async () => {
    const { rest, store } = fakeRest();
    await applyDeploy(rest, cfg, () => {});
    store.endpoints[0].name = `${NAMES.keyframe} -fb`;
    expect((await planDeploy(rest)).every((s) => s.action === "update")).toBe(true);
    await applyDeploy(rest, cfg, () => {});
    expect(store.endpoints.map((e) => e.name)).toEqual([`${NAMES.keyframe} -fb`, NAMES.clip]);
  });

  it("refuses to pick between two resources with the same name, before creating anything", async () => {
    const { rest, store, calls } = fakeRest();
    store.networkvolumes.push({ id: "v1", name: NAMES.volume }, { id: "v2", name: NAMES.volume });
    await expect(planDeploy(rest)).rejects.toThrow(/networkvolumes.*flowchain-models/);
    await expect(applyDeploy(rest, cfg, () => {})).rejects.toThrow(/networkvolumes.*flowchain-models/);
    expect([store.templates.length, store.endpoints.length]).toEqual([0, 0]);
    expect(calls.filter((c) => c.startsWith("POST") && !c.endsWith("/account/secrets"))).toEqual([]);
  });

  it("refuses an ambiguous endpoint name before anything is written, secrets included", async () => {
    const { rest, store, calls, secrets } = fakeRest();
    store.endpoints.push({ id: "e1", name: NAMES.clip }, { id: "e2", name: `${NAMES.clip} -fb` });
    await expect(applyDeploy(rest, cfg, () => {})).rejects.toThrow(/endpoints.*flowchain-clip/);
    expect(calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
    expect(secrets.size).toBe(0);
  });

  it("keeps the endpoints warm for 30 s between a run's sequential jobs", async () => {
    const { rest, store } = fakeRest();
    await applyDeploy(rest, cfg, () => {});
    expect(store.endpoints.map((e) => e.idleTimeout)).toEqual([30, 30]);
  });

  it("grows a smaller volume, leaves a big enough one alone and refuses one in another data centre", async () => {
    const small = fakeRest();
    small.store.networkvolumes.push({ id: "v1", name: NAMES.volume, size: 40, dataCenterId: "EU-RO-1" });
    expect((await applyDeploy(small.rest, cfg, () => {})).volumeId).toBe("v1");
    expect(small.store.networkvolumes[0].size).toBe(80);

    const big = fakeRest();
    big.store.networkvolumes.push({ id: "v1", name: NAMES.volume, size: 200, dataCenterId: "EU-RO-1" });
    await applyDeploy(big.rest, cfg, () => {});
    expect(big.store.networkvolumes[0].size).toBe(200);
    expect(big.calls.filter((c) => c.includes("networkvolumes") && c.startsWith("PATCH"))).toEqual([]);

    const elsewhere = fakeRest();
    elsewhere.store.networkvolumes.push({ id: "v1", name: NAMES.volume, size: 80, dataCenterId: "US-CA-2" });
    await expect(applyDeploy(elsewhere.rest, cfg, () => {})).rejects.toThrow(/lives in US-CA-2, not EU-RO-1/);
    expect(elsewhere.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
    expect(elsewhere.secrets.size).toBe(0);
  });

  it("never puts the R2 keys in the template, the endpoints or the log", async () => {
    const { rest, store } = fakeRest();
    const logs: string[] = [];
    const keys = { ...cfg.r2, accessKeyId: "AKIA-distinct-access-4711", secretAccessKey: "sk-distinct-secret-4712" };
    await applyDeploy(rest, { ...cfg, r2: keys }, (m) => logs.push(m));
    await applyDeploy(rest, { ...cfg, r2: keys }, (m) => logs.push(m)); // the second run logs "already exists"
    const everything = JSON.stringify([store.networkvolumes, store.templates, store.endpoints, logs]);
    expect(everything).not.toContain(keys.accessKeyId);
    expect(everything).not.toContain(keys.secretAccessKey);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("seeds an endpoint's weights with a job that may run longer than the endpoint's normal limit", async () => {
    const api = new FakeRunpodApi(() => [{ status: "IN_PROGRESS" }, { status: "COMPLETED", output: { downloaded: ["a"], skipped: ["b"] } }]);
    const done = await fetchModels(new RunpodClient("k", { fetch: api.fetch }), "ep-c", "clip", { pollMs: 1, sleep: async () => {} });
    expect(done).toEqual({ downloaded: ["a"], skipped: ["b"] });
    expect(api.runs[0].input).toEqual({ task: "fetch-models", only: "clip" });
    expect(api.runs[0].policy).toEqual({ executionTimeout: 3_600_000, ttl: 2 * 3_600_000 });
  });

  it("writes the endpoint ids into .env, replacing old values and keeping everything else", async () => {
    const path = join(await tempDir(), ".env");
    await writeFile(path, "GEMINI_API_KEY=g\nRUNPOD_CLIP_ENDPOINT=old\n");
    await writeEnvValues(path, { RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c" });
    expect(await readFile(path, "utf8")).toBe("GEMINI_API_KEY=g\nRUNPOD_CLIP_ENDPOINT=ep-c\nRUNPOD_KEYFRAME_ENDPOINT=ep-k\n");
  });

  it("writes .env through a temp file that is renamed over it, leaving no temp file behind", async () => {
    const dir = await tempDir();
    const path = join(dir, ".env");
    await writeFile(path, "A=1\n\nB=2\n");
    await writeEnvValues(path, { B: "3", C: "4" });
    expect(await readFile(path, "utf8")).toBe("A=1\n\nB=3\nC=4\n");
    expect(await readdir(dir)).toEqual([".env"]);
    const fresh = join(dir, "new.env");
    await writeEnvValues(fresh, { X: "1" });
    expect(await readFile(fresh, "utf8")).toBe("X=1\n");
    expect((await readdir(dir)).sort()).toEqual([".env", "new.env"]);
  });
});

describe("worker image tag", () => {
  it("follows the first 12 characters of the tree hash of workers/", () => {
    expect(workerImageTag("0123456789abcdef0123456789abcdef01234567")).toBe("w-0123456789ab");
  });
});

describe("assertImageInGhcr", () => {
  const image = "ghcr.io/me/flowchain-worker:w-0123456789ab";

  /** A GHCR stand-in: the token endpoint answers `token`, the manifest HEAD answers `manifest`. */
  function ghcr(token: number | Error, manifest: number | Error = 200) {
    const calls: Array<{ url: string; method: string; headers: Headers }> = [];
    const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = String(url);
      calls.push({ url: u, method: init.method ?? "GET", headers: new Headers(init.headers) });
      const answer = u.startsWith("https://ghcr.io/token") ? token : manifest;
      if (answer instanceof Error) throw answer;
      return new Response(u.startsWith("https://ghcr.io/token") ? JSON.stringify({ token: "tok" }) : null, { status: answer });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("passes when the manifest exists, asking anonymously for the tag", async () => {
    const { fetchImpl, calls } = ghcr(200);
    await assertImageInGhcr(image, () => {}, fetchImpl);
    expect(calls[0].url).toBe("https://ghcr.io/token?scope=repository:me/flowchain-worker:pull");
    expect(calls[1]).toMatchObject({ url: "https://ghcr.io/v2/me/flowchain-worker/manifests/w-0123456789ab", method: "HEAD" });
    expect(calls[1].headers.get("authorization")).toBe("Bearer tok");
    expect(calls[1].headers.get("accept")).toContain("application/vnd.oci.image.index.v1+json");
  });

  it("throws a clear error when the image is missing or the package is private", async () => {
    for (const status of [404, 401, 403]) {
      await expect(assertImageInGhcr(image, () => {}, ghcr(200, status).fetchImpl)).rejects.toThrow(
        /is not in GHCR or the package is not public: push `main`, wait for the worker-image Action, make the package public/,
      );
    }
    await expect(assertImageInGhcr(image, () => {}, ghcr(404).fetchImpl)).rejects.toThrow(/not in GHCR/);
  });

  it("only warns when GHCR cannot be reached, and skips other registries", async () => {
    const warnings: string[] = [];
    await assertImageInGhcr(image, (m) => warnings.push(m), ghcr(new Error("offline")).fetchImpl);
    await assertImageInGhcr(image, (m) => warnings.push(m), ghcr(200, 503).fetchImpl);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/could not check.*offline.*continuing/);
    const untouched = ghcr(new Error("must not be called"));
    await assertImageInGhcr("docker.io/me/worker:1", warnings.push.bind(warnings), untouched.fetchImpl);
    expect(untouched.calls).toEqual([]);
  });
});
