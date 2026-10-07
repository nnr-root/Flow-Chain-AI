import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { AwsClient } from "aws4fetch";
import type { StoreSettings } from "@/server/store/s3";

/* A throwaway S3-compatible store (MinIO in Docker) standing in for R2 in tests: real signatures, real range requests. */

export function hasDocker(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
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

export type TestStore = { settings: StoreSettings; env: Record<string, string>; stop: () => void };

/** Starts MinIO on a free local port with one empty bucket. */
export async function startStore(): Promise<TestStore> {
  const port = await freePort();
  const name = `fc-minio-${port}`;
  const [user, password] = ["flowchain-test", "flowchain-test-secret"];
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:9000`, "-e", `MINIO_ROOT_USER=${user}`, "-e", `MINIO_ROOT_PASSWORD=${password}`, "minio/minio", "server", "/data"], { stdio: "ignore" });
  const settings: StoreSettings = { endpoint: `http://127.0.0.1:${port}`, bucket: "studio", accessKeyId: user, secretAccessKey: password };
  const aws = new AwsClient({ accessKeyId: user, secretAccessKey: password, service: "s3", region: "auto" });
  const stop = () => {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      // already gone
    }
  };
  try {
    for (let i = 0; ; i++) {
      const res = await aws.fetch(`${settings.endpoint}/${settings.bucket}`, { method: "PUT" }).catch(() => null);
      if (res?.ok || res?.status === 409) break;
      if (i > 150) throw new Error("the test store did not come up");
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (err) {
    stop();
    throw err;
  }
  const env = { STUDIO_BUCKET: settings.bucket, STUDIO_S3_ENDPOINT: settings.endpoint, STUDIO_R2_ACCESS_KEY_ID: user, STUDIO_R2_SECRET_ACCESS_KEY: password };
  return { settings, env, stop };
}
