import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Redis } from "ioredis";

/** Whether this machine can start a throwaway Redis for the queue tests (`redis-server` on the PATH). */
export function hasRedisServer(): boolean {
  try {
    execFileSync("redis-server", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

async function ready(url: string): Promise<void> {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
  } finally {
    client.disconnect();
  }
}

export type TestRedis = { url: string; stop: () => Promise<void>; start: () => Promise<void> };

/** A private Redis on a free port with an append-only file in a temp folder, so it can be stopped and started again. */
export async function startRedis(): Promise<TestRedis> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "fc-redis-"));
  const url = `redis://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  const start = async () => {
    child = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--dir", dir, "--appendonly", "yes", "--appendfsync", "always", "--save", ""], { stdio: "ignore" });
    for (let i = 0; ; i++) {
      try {
        await ready(url);
        return;
      } catch (err) {
        if (i > 100) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };
  const stop = async () => {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null) return;
    await new Promise<void>((done) => {
      running.once("exit", () => done());
      running.kill("SIGTERM");
    });
  };
  await start();
  return { url, stop, start };
}

export type TestWorker = { child: ChildProcess; output: () => string; exited: Promise<number | null>; stop: () => Promise<number | null> };

/** The real worker in its own process (so a test can kill it), against the test's Redis, runs folder and stub CLI. */
export function startWorkerProcess(env: Record<string, string>): TestWorker {
  let text = "";
  const child = spawn(process.execPath, ["--import", "tsx", "worker/main.ts"], {
    cwd: resolve("web"),
    env: { ...process.env, WORKER_GUARD_TTL_MS: "1500", WORKER_LOCK_MS: "1000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d: Buffer) => (text += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (text += d.toString()));
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  return {
    child,
    output: () => text,
    exited,
    stop: () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      return exited;
    },
  };
}
