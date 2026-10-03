/** Per-call timeouts. For queued fal jobs, image/video bound the wait for one submitted request. */
export const TIMEOUTS = { llm: 60_000, tts: 60_000, submit: 60_000, image: 120_000, video: 600_000 } as const;

/** Retrying the same call cannot fix this error. */
export class NonRetryableError extends Error {}

/** The provider finished (and billed) the job, but its output cannot be used. */
export class UnusableResultError extends NonRetryableError {}

/** An HTTP error from a provider; `status` decides whether a retry can help. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Client errors that fail the same way every time (bad request, auth, unknown voice, validation). */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) return false;
  const status = (err as { status?: unknown } | null)?.status;
  return !(typeof status === "number" && NON_RETRYABLE_STATUS.has(status));
}

export type RetryOptions = {
  attempts?: number;
  timeoutMs: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Races each attempt against a timeout so a hung provider call can never stall the pipeline.
 * Only use it for calls that are safe to repeat (nothing is bought twice): LLM and TTS requests,
 * and polling an already submitted fal request. Never wrap a fal submit in it.
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { attempts = 3, timeoutMs, baseDelayMs = 2000, sleep = realSleep } = opts;
  let lastError: unknown;
  let attempt = 0;
  while (attempt < attempts) {
    attempt++;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      return await Promise.race([fn(), timeout]);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) break;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const tries = `${attempt} attempt${attempt === 1 ? "" : "s"}`;
  throw new Error(`${label} failed after ${tries}: ${message}`, { cause: lastError });
}
