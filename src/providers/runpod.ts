import { HttpError } from "./retry.js";

export type RunpodStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";

/** A job as `/status` reports it. Times are milliseconds. */
export type RunpodJob = {
  id: string;
  status: RunpodStatus;
  output?: unknown;
  error?: unknown;
  executionTime?: number;
  delayTime?: number;
};

/** Caps RunPod enforces per job: run time and time-to-live (queue + run), both in milliseconds. */
export type RunpodPolicy = { executionTimeout: number; ttl: number };

export type RunpodClientOptions = { baseUrl?: string; fetch?: typeof fetch };

/**
 * The RunPod Serverless queue API (2.4 spec §3.1). `run` buys one job and is never retried here; `status` and
 * `health` are read-only and safe to repeat. Errors carry the HTTP status, so `isRetryable` decides.
 */
export class RunpodClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiKey: string,
    opts: RunpodClientOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://api.runpod.ai/v2";
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  private static async fail(what: string, res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    throw new HttpError(`RunPod ${what} failed: HTTP ${res.status} ${text.slice(0, 300)}`.trim(), res.status);
  }

  /** Buys one job; aborting `signal` cancels the HTTP request. Returns the job id. */
  async run(endpointId: string, input: unknown, policy: RunpodPolicy, signal: AbortSignal): Promise<string> {
    const res = await this.call("POST", `/${endpointId}/run`, { input, policy }, signal);
    if (!res.ok) await RunpodClient.fail(`run on endpoint ${endpointId}`, res);
    const body = (await res.json()) as { id?: unknown };
    if (typeof body.id !== "string") throw new Error(`RunPod run on endpoint ${endpointId} returned no job id`);
    return body.id;
  }

  /** The job's state, or null when RunPod no longer knows it (its result expired). */
  async status(endpointId: string, jobId: string): Promise<RunpodJob | null> {
    const res = await this.call("GET", `/${endpointId}/status/${jobId}`);
    if (res.status === 404) return null;
    if (!res.ok) await RunpodClient.fail(`status of job ${jobId}`, res);
    return (await res.json()) as RunpodJob;
  }

  async cancel(endpointId: string, jobId: string): Promise<void> {
    const res = await this.call("POST", `/${endpointId}/cancel/${jobId}`);
    if (!res.ok) await RunpodClient.fail(`cancel of job ${jobId}`, res);
  }

  /** Worker and job counts of an endpoint (used by doctor). */
  async health(endpointId: string): Promise<unknown> {
    const res = await this.call("GET", `/${endpointId}/health`);
    if (!res.ok) await RunpodClient.fail(`health of endpoint ${endpointId}`, res);
    return res.json();
  }
}
