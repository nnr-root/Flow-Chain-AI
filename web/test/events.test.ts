import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEvents } from "@/server/events";
import { draftManifest, finishedManifest, nextRunId, saveRun, useStudio } from "./helpers";

const studio = useStudio();

/** Reads the stream until `count` events of the wanted kinds arrived. */
async function take(stream: ReadableStream<Uint8Array>, count: number, kinds = ["run", "log"]) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buffer = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data && kinds.includes(event)) events.push({ event, data: JSON.parse(data) });
    }
  }
  return { events, reader };
}

describe("run events", () => {
  it("sends the run at once, again when its manifest changes, and new log lines as they are written", async () => {
    const id = nextRunId();
    const dir = await saveRun(studio, draftManifest(id));
    await appendFile(join(dir, "job.log"), "old line the page already has\n");
    const abort = new AbortController();
    const stream = runEvents(id, abort.signal, { debounceMs: 10, heartbeatMs: 60_000 });

    const first = await take(stream, 1);
    expect(first.events[0]).toMatchObject({ event: "run", data: { runId: id, state: "draft" } });
    first.reader.releaseLock();

    await saveRun(studio, finishedManifest(id));
    await appendFile(join(dir, "job.log"), "render: 100%\n");
    const next = await take(stream, 2);
    expect(next.events.find((e) => e.event === "run")?.data.state).toBe("done");
    expect(next.events.find((e) => e.event === "log")?.data.lines).toEqual(["render: 100%"]);
    abort.abort();
    expect((await next.reader.read()).done).toBe(true);
  });

  it("notices a job that ended without touching a file, at the next heartbeat", async () => {
    const id = nextRunId();
    const dir = join(studio.runs, id);
    await saveRun(studio, draftManifest(id));
    const { writeFile } = await import("node:fs/promises");
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await writeFile(join(dir, "job.json"), JSON.stringify({ id: "j", kind: "generate", args: [], pid: child.pid, startedAt: "t" }));
    const abort = new AbortController();
    const stream = runEvents(id, abort.signal, { debounceMs: 10, heartbeatMs: 50 });
    const first = await take(stream, 1);
    expect(first.events[0].data.state).toBe("running");
    first.reader.releaseLock();
    await new Promise((r) => setTimeout(r, 200)); // let the watcher settle on job.json's own write
    child.kill("SIGKILL");
    const next = await take(stream, 1, ["run"]);
    expect(next.events[0].data.state).toBe("interrupted");
    abort.abort();
  });

  it("an unknown run id never opens a stream", async () => {
    await mkdir(studio.runs, { recursive: true });
    expect(() => runEvents("../x", new AbortController().signal)).toThrow("no run");
  });
});
