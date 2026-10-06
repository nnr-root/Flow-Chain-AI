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
}
