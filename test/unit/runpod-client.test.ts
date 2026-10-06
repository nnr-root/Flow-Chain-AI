import { describe, expect, it } from "vitest";
import { R2 } from "../../src/providers/r2.js";
import { isRetryable } from "../../src/providers/retry.js";
import { RunpodClient } from "../../src/providers/runpod.js";
import { FakeRunpodApi } from "../fakes/runpod.js";

const policy = { executionTimeout: 120_000, ttl: 3_600_000 };

describe("RunpodClient", () => {
  it("submits the input with the policy and the bearer key, and returns the job id", async () => {
    const api = new FakeRunpodApi(() => [{ status: "COMPLETED", output: { url: "u" } }]);
    const client = new RunpodClient("key-1", { fetch: api.fetch });
    const id = await client.run("ep-1", { task: "keyframe" }, policy, new AbortController().signal);
    expect(id).toBe("job-1");
    expect(api.runs).toEqual([{ endpointId: "ep-1", input: { task: "keyframe" }, policy, authorization: "Bearer key-1" }]);
  });

  it("reports a refused submit with its HTTP status, so auth errors are not retried", async () => {
    const api = new FakeRunpodApi(() => []);
    api.failRun = 401;
    const client = new RunpodClient("bad", { fetch: api.fetch });
    const err = await client.run("ep-1", {}, policy, new AbortController().signal).catch((e: unknown) => e);
    expect(String(err)).toMatch(/RunPod run on endpoint ep-1 failed: HTTP 401/);
    expect(isRetryable(err)).toBe(false);
  });

  it("does not submit when the signal is already aborted", async () => {
    const api = new FakeRunpodApi(() => []);
    const client = new RunpodClient("k", { fetch: api.fetch });
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    await expect(client.run("ep-1", {}, policy, controller.signal)).rejects.toThrow("deadline");
    expect(api.runs).toHaveLength(0);
  });

  it("walks a job's statuses and answers null once RunPod has forgotten it", async () => {
    const api = new FakeRunpodApi(() => [
      { status: "IN_QUEUE" },
      { status: "IN_PROGRESS" },
      { status: "COMPLETED", output: { url: "u" }, executionTime: 4200 },
    ]);
    const client = new RunpodClient("k", { fetch: api.fetch });
    const id = await client.run("ep-1", {}, policy, new AbortController().signal);
    expect((await client.status("ep-1", id))?.status).toBe("IN_QUEUE");
    expect((await client.status("ep-1", id))?.status).toBe("IN_PROGRESS");
    expect(await client.status("ep-1", id)).toMatchObject({ status: "COMPLETED", executionTime: 4200 });
    api.expire(id);
    expect(await client.status("ep-1", id)).toBeNull();
  });
});

describe("R2", () => {
  const config = { accountId: "acc", bucket: "flowchain-out", accessKeyId: "AKID", secretAccessKey: "SECRET" };

  it("presigns a 7-day GET link locally", async () => {
    const url = new URL(await new R2(config).presignGet("flowchain/job-1.png"));
    expect(url.origin).toBe("https://acc.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/flowchain-out/flowchain/job-1.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^AKID\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checks whether an object exists with a signed HEAD", async () => {
    const seen: Array<{ method: string; auth: string | null }> = [];
    const fetchStub = async (req: string | URL | Request) => {
      const r = req as Request;
      seen.push({ method: r.method, auth: r.headers.get("authorization") });
      return new Response(null, { status: r.url.endsWith("there.mp4") ? 200 : 404 });
    };
    const r2 = new R2(config, { fetch: fetchStub as typeof fetch });
    expect(await r2.exists("flowchain/there.mp4")).toBe(true);
    expect(await r2.exists("flowchain/gone.mp4")).toBe(false);
    expect(seen.map((s) => s.method)).toEqual(["HEAD", "HEAD"]);
    expect(seen[0].auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//);
  });
});
