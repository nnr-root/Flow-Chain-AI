import { existsSync, type FSWatcher, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { JOB_LOG } from "./jobs";
import { readRun, runDir } from "./runs";

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * A run's live feed as server-sent events: `run` (state, job and status) whenever its folder changes, `log` for
 * new job output, and a comment line every 15 s so proxies and the browser keep the connection open.
 */
export function runEvents(runId: string, signal: AbortSignal, opts: { heartbeatMs?: number; debounceMs?: number } = {}): ReadableStream<Uint8Array> {
  const dir = runDir(runId);
  const logPath = join(dir, JOB_LOG);
  let watcher: FSWatcher | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let logAt = 0;
  let last = "";
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        watcher?.close();
        clearInterval(heartbeat);
        clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      const send = (bytes: Uint8Array) => {
        if (!closed) controller.enqueue(bytes);
      };
      const sendLog = async () => {
        const size = await stat(logPath).then((s) => s.size, () => 0);
        if (size < logAt) logAt = 0; // truncated
        if (size === logAt) return;
        const handle = await open(logPath, "r");
        try {
          const buf = Buffer.alloc(Math.min(size - logAt, 64 * 1024));
          await handle.read(buf, 0, buf.length, size - buf.length);
          logAt = size;
          const lines = buf.toString("utf8").split("\n").map((l) => l.trimEnd()).filter(Boolean);
          if (lines.length) send(frame("log", { lines }));
        } finally {
          await handle.close();
        }
      };
      const sendRun = async () => {
        try {
          const view = await readRun(runId);
          const text = JSON.stringify(view);
          if (text !== last) {
            last = text;
            send(frame("run", view));
          }
          await sendLog();
        } catch {
          // mid-write or not created yet: the next change tries again
        }
      };

      signal.addEventListener("abort", close);
      // only what was written from now on is "new" output; the page already shows the tail it loaded
      logAt = await stat(logPath).then((s) => s.size, () => 0);
      await sendRun();
      if (existsSync(dir)) {
        // the manifest is replaced by rename, so the folder is watched, not the file
        watcher = watch(dir, () => {
          clearTimeout(timer);
          timer = setTimeout(() => void sendRun(), opts.debounceMs ?? 150);
        });
        watcher.on("error", close);
      }
      // a job's end is a process exiting, which no file change announces when it was killed: poll as well
      heartbeat = setInterval(() => {
        send(encoder.encode(": keep-alive\n\n"));
        void sendRun();
      }, opts.heartbeatMs ?? 15_000);
    },
    cancel() {
      closed = true;
      watcher?.close();
      clearInterval(heartbeat);
      clearTimeout(timer);
    },
  });
}
