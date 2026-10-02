import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** JSON with sorted object keys and undefined values dropped, so equal data always hashes equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export function inputHash(stage: string, inputs: unknown): string {
  return sha256(stableStringify({ stage, inputs }));
}
