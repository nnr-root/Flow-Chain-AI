import type { RunpodJob } from "../../src/providers/runpod.js";

type Step = Omit<RunpodJob, "id">;

/**
 * An in-memory RunPod Serverless API behind an injectable `fetch`. Each job walks through the statuses that
 * `script` returns (one per /status call; the last one repeats); `expire(id)` makes /status answer 404.
 */
export class FakeRunpodApi {
  runs: Array<{ endpointId: string; input: Record<string, unknown>; policy: unknown; authorization: string | null }> = [];
  statusCalls = 0;
  cancels: string[] = [];
  /** Answer /run with this HTTP status instead of queuing a job. */
  failRun?: number;
  private readonly jobs = new Map<string, { steps: Step[]; polled: number; expired: boolean }>();

  constructor(private readonly script: (input: Record<string, unknown>, n: number) => Step[]) {}

  expire(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) job.expired = true;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init.signal?.aborted) throw init.signal.reason ?? new Error("aborted");
    const [, , endpointId, action, jobId] = url.pathname.split("/");
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (action === "run" && init.method === "POST") {
      if (this.failRun) return json(this.failRun, { error: "refused" });
      const body = JSON.parse(String(init.body)) as { input: Record<string, unknown>; policy: unknown };
      const authorization = new Headers(init.headers).get("authorization");
      this.runs.push({ endpointId, input: body.input, policy: body.policy, authorization });
      const id = `job-${this.runs.length}`;
      this.jobs.set(id, { steps: this.script(body.input, this.runs.length), polled: 0, expired: false });
      return json(200, { id, status: "IN_QUEUE" });
    }
    if (action === "status") {
      this.statusCalls++;
      const job = this.jobs.get(jobId);
      if (!job || job.expired) return json(404, { error: "job not found" });
      const step = job.steps[Math.min(job.polled, job.steps.length - 1)];
      job.polled++;
      return json(200, { id: jobId, ...step });
    }
    if (action === "cancel") {
      this.cancels.push(jobId);
      return json(200, { id: jobId, status: "CANCELLED" });
    }
    if (action === "health") return json(200, { jobs: { completed: 0 }, workers: { idle: 0, running: 0 } });
    return json(404, { error: "unknown route" });
  };
}
