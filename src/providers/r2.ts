import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";

export type R2Config = { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };

/** Seconds a presigned download link stays valid (S3's maximum). */
export const PRESIGN_SECONDS = 7 * 24 * 3600;

/**
 * The Cloudflare R2 bucket the workers upload to (2.4 spec §3.1, §7), through its S3 API. The pipeline only
 * needs to find a finished job's file again (after RunPod's 30-minute result window) and doctor's round trip.
 */
export class R2 {
  private readonly aws: AwsClient;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: R2Config,
    opts: { fetch?: typeof fetch } = {},
  ) {
    this.aws = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  objectUrl(key: string): string {
    return `${this.endpoint}/${this.config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** A GET link anyone can download for `seconds`, signed locally (no request is made). */
  async presignGet(key: string, seconds = PRESIGN_SECONDS): Promise<string> {
    const signed = await this.aws.sign(`${this.objectUrl(key)}?X-Amz-Expires=${seconds}`, {
      method: "GET",
      aws: { signQuery: true },
    });
    return signed.url;
  }

  private async send(method: "HEAD" | "GET" | "PUT" | "DELETE", key: string, body?: string): Promise<Response> {
    const signed = await this.aws.sign(this.objectUrl(key), { method, body });
    return this.fetchImpl(signed);
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.send("HEAD", key);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`R2 HEAD ${key} failed: HTTP ${res.status}`);
    return true;
  }

  async put(key: string, body: string): Promise<void> {
    const res = await this.send("PUT", key, body);
    if (!res.ok) throw new Error(`R2 PUT ${key} failed: HTTP ${res.status}`);
  }

  async get(key: string): Promise<string> {
    const res = await this.send("GET", key);
    if (!res.ok) throw new Error(`R2 GET ${key} failed: HTTP ${res.status}`);
    return res.text();
  }

  async delete(key: string): Promise<void> {
    const res = await this.send("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} failed: HTTP ${res.status}`);
  }

  /**
   * Has the bucket remove what is under `prefix` after `days` (phase 5 spec §8): what a worker uploads is
   * fetched by the pipeline within minutes, and nothing of a customer's is to lie in a bucket longer than it is
   * needed. This is the bucket's ONE lifecycle rule set: it replaces whatever rules it had.
   */
  async expireAfter(prefix: string, days: number): Promise<void> {
    if (!Number.isInteger(days) || days < 1) throw new Error("days must be a whole number, 1 or more");
    if (!/^[A-Za-z0-9_-]+\/$/.test(prefix)) throw new Error("the prefix must be one folder name ending in a slash");
    const body =
      `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      `<Rule><ID>flowchain-expire-${prefix.slice(0, -1)}</ID><Status>Enabled</Status><Filter><Prefix>${prefix}</Prefix></Filter>` +
      `<Expiration><Days>${days}</Days></Expiration></Rule></LifecycleConfiguration>`;
    const signed = await this.aws.sign(`${this.endpoint}/${this.config.bucket}?lifecycle`, {
      method: "PUT", body, headers: { "content-type": "application/xml", "content-md5": createHash("md5").update(body).digest("base64") },
    });
    const res = await this.fetchImpl(signed);
    if (!res.ok) throw new Error(`R2 could not set the bucket's expiry rule: HTTP ${res.status}`);
  }
}
