import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Downloads immediately: provider-hosted URLs expire, so the local copy is the source of truth. */
export async function download(
  url: string,
  dest: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), dest);
    return;
  }
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  let body: Buffer;
  try {
    // the signal also covers reading the body, so a stalled transfer cannot hang the run
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const reason = timedOut ? `timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : String(err);
    throw new Error(`download of ${url} failed: ${reason}`, { cause: err });
  }
  await writeFile(dest, body);
}
