// The studio's worker: `node --import tsx worker/main.ts`, run from web/ (it shares the studio's server code).
import { SecondWorker, startWorker } from "./worker";

const url = process.env.REDIS_URL?.trim();
if (!url) {
  console.error("REDIS_URL is not set: the worker has no queue to take jobs from");
  process.exit(1);
}
const number = (name: string): number | undefined => {
  const raw = process.env[name]?.trim() ?? "";
  return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : undefined;
};

try {
  const worker = await startWorker({
    redisUrl: url,
    concurrency: number("WORKER_CONCURRENCY"),
    drainMs: number("WORKER_DRAIN_MS"),
    guardTtlMs: number("WORKER_GUARD_TTL_MS"),
    lockMs: number("WORKER_LOCK_MS"),
  });
  const stop = () => {
    void worker.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(err instanceof SecondWorker ? 3 : 1);
}
