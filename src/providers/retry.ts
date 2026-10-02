export const TIMEOUTS = { llm: 60_000, tts: 60_000, image: 120_000, video: 600_000 } as const;

export type RetryOptions = {
  attempts?: number;
  timeoutMs: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Races each attempt against a timeout so a hung provider call can never stall the pipeline. */
export async function withRetry<T>(label: string, fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { attempts = 3, timeoutMs, baseDelayMs = 2000, sleep = realSleep } = opts;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      return await Promise.race([fn(), timeout]);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed after ${attempts} attempts: ${message}`);
}
