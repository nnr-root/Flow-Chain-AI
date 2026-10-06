import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyDeploy, DEFAULTS, fetchModels, NAMES, planDeploy, RunpodRest, writeEnvValues } from "../../src/deploy/runpod.js";
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
    if (init.method === "GET") return json(200, store[kind]);
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
      [NAMES.clip, ["NVIDIA L40S"], 600_000, 2, ids.volumeId],
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

  it("seeds an endpoint's weights with a job that may run longer than the endpoint's normal limit", async () => {
    const api = new FakeRunpodApi(() => [{ status: "IN_PROGRESS" }, { status: "COMPLETED", output: { downloaded: ["a"], skipped: ["b"] } }]);
    const done = await fetchModels(new RunpodClient("k", { fetch: api.fetch }), "ep-c", "clip", { pollMs: 1, sleep: async () => {} });
    expect(done).toEqual({ downloaded: ["a"], skipped: ["b"] });
    expect(api.runs[0].input).toEqual({ task: "fetch-models", only: "clip" });
    expect(api.runs[0].policy).toEqual({ executionTimeout: 3 * 3_600_000, ttl: 4 * 3_600_000 });
  });

  it("writes the endpoint ids into .env, replacing old values and keeping everything else", async () => {
    const path = join(await tempDir(), ".env");
    await writeFile(path, "GEMINI_API_KEY=g\nRUNPOD_CLIP_ENDPOINT=old\n");
    await writeEnvValues(path, { RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c" });
    expect(await readFile(path, "utf8")).toBe("GEMINI_API_KEY=g\nRUNPOD_CLIP_ENDPOINT=ep-c\nRUNPOD_KEYFRAME_ENDPOINT=ep-k\n");
  });
});
