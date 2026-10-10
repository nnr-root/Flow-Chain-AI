import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDeploy, applyVoiceDeploy, assertImageInGhcr, DEFAULTS, fetchModels, NAMES, planDeploy, planVoiceDeploy, removeRetiredVolumes, RunpodRest, VOICE_DEFAULTS, voiceImageTag,
  workerImageTag, writeEnvValues,
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
      // like RunPod: a new endpoint has FlashBoot on whatever was asked; only a later change turns it off
      const r = { id: `${kind}-${++n}`, ...body, ...(kind === "endpoints" ? { flashboot: true } : {}) };
      store[kind].push(r);
      return json(200, r);
    }
    if (init.method === "DELETE") {
      store[kind] = store[kind].filter((x) => x.id !== id);
      return new Response(null, { status: 204 });
    }
    const r = store[kind].find((x) => x.id === id)!;
    Object.assign(r, body);
    return json(200, r);
  };
  return { rest: new RunpodRest("key", fetchImpl as typeof fetch), store, secrets, calls };
}

const cfg = {
  image: "ghcr.io/me/flowchain-worker:latest",
  pictureImage: "ghcr.io/me/flowchain-picture:latest",
  dataCenterId: "EU-RO-1",
  volumeGb: 80,
  keyframeGpus: DEFAULTS.keyframeGpus,
  clipGpus: DEFAULTS.clipGpus,
  r2: { accountId: "acc", bucket: "out", accessKeyId: "AK", secretAccessKey: "SK" },
};

describe("runpod deploy", () => {
  it("creates the volume, a template for each worker and both endpoints, with R2 keys as secrets", async () => {
    const { rest, store, secrets } = fakeRest();
    expect((await planDeploy(rest)).map((s) => `${s.action} ${s.name}`)).toEqual([
      "create flowchain-weights",
      "create flowchain-worker",
      "create flowchain-picture",
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
    // the picture worker has its own image, with the same bucket settings and secrets
    expect(store.templates[1]).toMatchObject({ name: NAMES.pictureTemplate, imageName: cfg.pictureImage, isServerless: true, env: store.templates[0].env });
    // each endpoint runs its own worker; the picture worker's PyTorch needs a host with CUDA 12.8
    expect(store.endpoints.map((e) => [e.name, e.templateId, e.minCudaVersion])).toEqual([
      [NAMES.keyframe, store.templates[1].id, "12.8"],
      [NAMES.clip, store.templates[0].id, undefined],
    ]);
    expect(store.endpoints.map((e) => [e.name, e.gpuTypeIds, e.executionTimeoutMs, e.workersMax, e.networkVolumeId])).toEqual([
      [NAMES.keyframe, ["NVIDIA GeForce RTX 4090"], 120_000, 1, ids.volumeId],
      [NAMES.clip, ["NVIDIA GeForce RTX 4090"], 600_000, 1, ids.volumeId],
    ]);
    expect([...secrets].sort()).toEqual(["flowchain_r2_access_key_id", "flowchain_r2_secret_access_key"]);
  });

  it("updates instead of duplicating on a second run, and keeps existing secrets", async () => {
    const { rest, store } = fakeRest();
    const first = await applyDeploy(rest, cfg, () => {});
    const logs: string[] = [];
    const second = await applyDeploy(rest, { ...cfg, image: "ghcr.io/me/flowchain-worker:abc123" }, (m) => logs.push(m));
    expect(second).toEqual(first);
    expect([store.networkvolumes.length, store.templates.length, store.endpoints.length]).toEqual([1, 2, 2]);
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
    await expect(planDeploy(rest)).rejects.toThrow(/networkvolumes.*flowchain-weights/);
    await expect(applyDeploy(rest, cfg, () => {})).rejects.toThrow(/networkvolumes.*flowchain-weights/);
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
    // a worker keeps nothing of a job after it stops: no state is carried over to its next start
    expect(store.endpoints.map((e) => e.flashboot)).toEqual([false, false]);
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

describe("the voice endpoint's deploy", () => {
  const voice = { image: "ghcr.io/me/flowchain-voice:v-abc", gpus: VOICE_DEFAULTS.gpus };

  it("creates a template and an endpoint of its own: no volume, no secret, no data centre, and no state kept between workers", async () => {
    const { rest, store, secrets } = fakeRest();
    expect((await planVoiceDeploy(rest)).map((s) => `${s.action} ${s.what} ${s.name}`)).toEqual(["create template flowchain-voice", "create endpoint flowchain-voice"]);
    const made = await applyVoiceDeploy(rest, voice);
    expect(store.templates).toEqual([expect.objectContaining({ id: made.templateId, name: "flowchain-voice", imageName: voice.image, isServerless: true, env: {} })]);
    const [endpoint] = store.endpoints;
    expect(endpoint).toMatchObject({ id: made.endpointId, name: "flowchain-voice", templateId: made.templateId, gpuTypeIds: voice.gpus, workersMin: 0, workersMax: 1, flashboot: false, minCudaVersion: "12.8", executionTimeoutMs: 120_000 });
    // it uploads nothing and reads no weights from a volume: nothing ties it to a bucket or a place
    for (const absent of ["networkVolumeId", "dataCenterIds"]) expect(endpoint).not.toHaveProperty(absent);
    expect(secrets.size).toBe(0);
    expect(store.networkvolumes).toEqual([]);
  });

  it("updates in place on a second run, and leaves the picture and clip endpoints alone", async () => {
    const { rest, store } = fakeRest();
    await applyDeploy(rest, cfg, () => {});
    const first = await applyVoiceDeploy(rest, voice);
    expect((await planVoiceDeploy(rest)).map((s) => s.action)).toEqual(["update", "update"]);
    const second = await applyVoiceDeploy(rest, { ...voice, image: "ghcr.io/me/flowchain-voice:v-def" });
    expect(second).toEqual(first);
    expect(store.templates.map((t) => [t.name, t.imageName])).toEqual([[NAMES.template, cfg.image], [NAMES.pictureTemplate, cfg.pictureImage], ["flowchain-voice", "ghcr.io/me/flowchain-voice:v-def"]]);
    expect(store.endpoints.map((e) => e.name)).toEqual([NAMES.keyframe, NAMES.clip, "flowchain-voice"]);
    // the other endpoints still read their weights from the volume
    expect(store.endpoints.filter((e) => e.networkVolumeId).map((e) => e.name)).toEqual([NAMES.keyframe, NAMES.clip]);
  });

  it("tags the image by the content of its own folder", () => {
    expect(voiceImageTag("0123456789abcdef0123")).toBe("v-0123456789ab");
  });
});

describe("the volume used before", () => {
  const old = { id: "v-old", name: "flowchain-models", size: 110, dataCenterId: "EU-RO-1" };

  it("is left alone by a deploy, which makes the smaller one beside it and points both endpoints there", async () => {
    const { rest, store } = fakeRest();
    store.networkvolumes.push({ ...old });
    store.endpoints.push({ id: "e-k", name: NAMES.keyframe, networkVolumeId: "v-old", networkVolumeIds: ["v-old"] }, { id: "e-c", name: NAMES.clip, networkVolumeId: "v-old", networkVolumeIds: ["v-old"] });
    const ids = await applyDeploy(rest, { ...cfg, volumeGb: DEFAULTS.volumeGb }, () => {});
    expect(store.networkvolumes.map((v) => [v.name, v.size])).toEqual([["flowchain-models", 110], ["flowchain-weights", 50]]);
    expect(store.endpoints.map((e) => e.networkVolumeId)).toEqual([ids.volumeId, ids.volumeId]);
    // the list RunPod keeps beside the single id is moved with it: left alone it went on naming the old volume
    expect(store.endpoints.map((e) => e.networkVolumeIds)).toEqual([[ids.volumeId], [ids.volumeId]]);
    expect(ids.volumeId).not.toBe("v-old");
    // said, so the models are asked for twice: a worker may still answer from the old volume just after the move
    expect(ids.movedVolume).toBe(true);
    expect((await applyDeploy(rest, { ...cfg, volumeGb: DEFAULTS.volumeGb }, () => {})).movedVolume).toBe(false);
  });

  it("is deleted only when the new one exists and no endpoint reads from the old one", async () => {
    const alone = fakeRest();
    alone.store.networkvolumes.push({ ...old });
    await expect(removeRetiredVolumes(alone.rest)).rejects.toThrow(/flowchain-weights does not exist yet/);

    const inUse = fakeRest();
    inUse.store.networkvolumes.push({ ...old }, { id: "v-new", name: NAMES.volume, size: 50 });
    inUse.store.endpoints.push({ id: "e-c", name: NAMES.clip, networkVolumeId: "v-old" });
    await expect(removeRetiredVolumes(inUse.rest)).rejects.toThrow(/still read by flowchain-clip/);
    expect(inUse.store.networkvolumes).toHaveLength(2);
    // as it was after the first move: the single id says the new volume, the list still says the old one
    const listed = fakeRest();
    listed.store.networkvolumes.push({ ...old }, { id: "v-new", name: NAMES.volume, size: 50 });
    listed.store.endpoints.push({ id: "e-k", name: NAMES.keyframe, networkVolumeId: "v-new", networkVolumeIds: ["v-old"] });
    await expect(removeRetiredVolumes(listed.rest)).rejects.toThrow(/still read by flowchain-keyframe/);
    expect((await applyDeploy(listed.rest, { ...cfg, volumeGb: DEFAULTS.volumeGb }, () => {})).movedVolume).toBe(true);
    expect(inUse.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);

    const moved = fakeRest();
    moved.store.networkvolumes.push({ ...old }, { id: "v-new", name: NAMES.volume, size: 50 }, { id: "v-x", name: "someone-elses", size: 10 });
    moved.store.endpoints.push({ id: "e-c", name: NAMES.clip, networkVolumeId: "v-new" });
    expect(await removeRetiredVolumes(moved.rest)).toEqual(["flowchain-models"]);
    expect(moved.store.networkvolumes.map((v) => v.name)).toEqual([NAMES.volume, "someone-elses"]);
    // said again, there is nothing to do, and nothing is touched
    expect(await removeRetiredVolumes(moved.rest)).toEqual([]);
    expect(moved.calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /v1/networkvolumes/v-old"]);
  });
});
