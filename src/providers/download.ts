import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Downloads immediately: provider-hosted URLs expire, so the local copy is the source of truth. */
export async function download(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (url.startsWith("file://")) {
    await copyFile(fileURLToPath(url), dest);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download of ${url} failed: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
