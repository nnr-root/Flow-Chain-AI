import { randomBytes } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AwsClient } from "aws4fetch";

/* The studio's own bucket (Cloudflare R2, or any S3-compatible store in tests), through the S3 API. */

export type StoreSettings = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
export type StoredObject = { key: string; size: number };

/** Seconds a link to a stored file stays valid: long enough to start playing, too short to pass around. */
export const LINK_SECONDS = 300;

/**
 * Where the studio keeps what must outlive a server's disk: `STUDIO_BUCKET`, in the R2 account the pipeline
 * already uses unless `STUDIO_R2_*` name another. Null when no bucket is configured (everything stays on disk).
 */
export function storeSettings(env: Record<string, string | undefined> = process.env): StoreSettings | null {
  const bucket = env.STUDIO_BUCKET?.trim();
  if (!bucket) return null;
  const pick = (name: string) => env[`STUDIO_${name}`]?.trim() || env[name]?.trim();
  const account = pick("R2_ACCOUNT_ID");
  const endpoint = env.STUDIO_S3_ENDPOINT?.trim() || (account ? `https://${account}.r2.cloudflarestorage.com` : undefined);
  const accessKeyId = pick("R2_ACCESS_KEY_ID");
  const secretAccessKey = pick("R2_SECRET_ACCESS_KEY");
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("STUDIO_BUCKET is set, but the R2 account and keys are not (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  }
  return { endpoint: endpoint.replace(/\/$/, ""), bucket, accessKeyId, secretAccessKey };
}

/** What a stored file is, so that a link to it plays in a browser instead of downloading. */
const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".json": "application/json",
};

const xml = (text: string, tag: string): string[] => [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1]);
const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export class ObjectStore {
  private readonly aws: AwsClient;

  constructor(private readonly settings: StoreSettings) {
    this.aws = new AwsClient({ accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, service: "s3", region: "auto" });
  }

  private url(key: string): string {
    return `${this.settings.endpoint}/${this.settings.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** Uploads a file from disk. The body is the file itself, read as it is sent, with its size known up front. */
  async putFile(key: string, path: string): Promise<void> {
    const body = await openAsBlob(path);
    // the body is not hashed for the signature: that would read every video twice
    const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const res = await this.aws.fetch(this.url(key), { method: "PUT", body, headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "content-length": String(body.size), "content-type": type } });
    if (!res.ok) throw new Error(`storing ${key} failed: HTTP ${res.status}`);
    await res.arrayBuffer();
  }

  /** Downloads a stored file to disk, through a temporary name so a broken download is never taken for the file. */
  async getToFile(key: string, path: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key), { method: "GET" });
    if (!res.ok || !res.body) throw new Error(`fetching ${key} failed: HTTP ${res.status}`);
    await mkdir(dirname(path), { recursive: true });
    // a name nobody else has: two downloads of one file (two tabs, a job and a page) must not write into each other
    const partial = `${path}.${randomBytes(6).toString("hex")}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial));
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true });
    }
  }

  /** Every object under a prefix. */
  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) });
      const res = await this.aws.fetch(`${this.settings.endpoint}/${this.settings.bucket}?${query}`, { method: "GET" });
      if (!res.ok) throw new Error(`listing ${prefix} failed: HTTP ${res.status}`);
      const text = await res.text();
      const keys = xml(text, "Key").map(unescape);
      const sizes = xml(text, "Size").map(Number);
      keys.forEach((key, i) => out.push({ key, size: sizes[i] }));
      token = xml(text, "IsTruncated")[0] === "true" ? unescape(xml(text, "NextContinuationToken")[0] ?? "") : undefined;
      // "there is more" without saying where: half a listing must never be taken for all of it
      if (token === "") throw new Error(`listing ${prefix} was cut short`);
    } while (token);
    return out;
  }

  async remove(key: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`removing ${key} failed: HTTP ${res.status}`);
  }

  /** A link that downloads one stored file for a few minutes; signed here, without a request. */
  async link(key: string, seconds = LINK_SECONDS): Promise<string> {
    const signed = await this.aws.sign(`${this.url(key)}?X-Amz-Expires=${seconds}`, { method: "GET", aws: { signQuery: true } });
    return signed.url;
  }
}

/** The studio's bucket, or null when none is configured. */
export function objectStore(): ObjectStore | null {
  const settings = storeSettings();
  return settings ? new ObjectStore(settings) : null;
}
