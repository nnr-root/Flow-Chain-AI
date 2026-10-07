import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
  backupEnv, backupScript, backupUnits, composeCommand, composeEnv, composeEnvText, dockerEnvText, generatePassword, paths,
  prepareScript, serverConfig, shellQuote, unpackScript, upScript,
} from "../../src/deploy/server.js";
import { tempDir } from "../helpers/media.js";

const base = { SERVER_HOST: "203.0.113.7", STUDIO_HOST: "Studio.Example.com" };

describe("serverConfig", () => {
  it("fills in the defaults and gives the worker this machine's keys", () => {
    const cfg = serverConfig(base, { GEMINI_API_KEY: "g", FAL_KEY: " f ", EMPTY: " " });
    expect(cfg).toEqual({
      target: "root@203.0.113.7",
      dir: "/opt/flowchain",
      studioHost: "studio.example.com",
      studioUser: "studio",
      worker: { GEMINI_API_KEY: "g", FAL_KEY: "f" },
    });
  });

  it("lets server.env replace and add worker settings, and keeps the deployment's own settings out of them", () => {
    const cfg = serverConfig(
      { ...base, SERVER_USER: "deploy", SERVER_DIR: "/srv/studio", STUDIO_USER: "me", WORKER_CONCURRENCY: "3", PROVIDER_MODE: "runpod", FAL_KEY: "server" },
      { FAL_KEY: "local", PROVIDER_MODE: "fal" },
    );
    expect(cfg.target).toBe("deploy@203.0.113.7");
    expect(cfg.dir).toBe("/srv/studio");
    expect(cfg.concurrency).toBe(3);
    expect(cfg.worker).toEqual({ FAL_KEY: "server", PROVIDER_MODE: "runpod" });
  });

  it("keeps a local value off the server when server.env sets its name to nothing", () => {
    const cfg = serverConfig({ ...base, RUNPOD_API_KEY: "", FAL_KEY: " " }, { RUNPOD_API_KEY: "local", FAL_KEY: "local", GEMINI_API_KEY: "g" });
    expect(cfg.worker).toEqual({ GEMINI_API_KEY: "g" });
  });

  it("never passes on a local path or queue address: the Compose file owns those on the server", () => {
    const cfg = serverConfig(base, { RUNS_DIR: "/Users/me/runs", BRAND_KITS_DIR: "x", STUDIO_UPLOADS_DIR: "y", REDIS_URL: "redis://localhost", FLOWCHAIN_CLI: "stub", GEMINI_API_KEY: "g" });
    expect(cfg.worker).toEqual({ GEMINI_API_KEY: "g" });
  });

  it("takes the backup's R2 account from the worker's keys unless given its own", () => {
    const r2 = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" };
    expect(serverConfig({ ...base, BACKUP_BUCKET: "backups" }, r2).backup).toEqual({ bucket: "backups", accountId: "acc", accessKeyId: "id", secretAccessKey: "secret" });
    const own = serverConfig({ ...base, BACKUP_BUCKET: "backups", BACKUP_R2_ACCESS_KEY_ID: "other" }, r2);
    expect(own.backup?.accessKeyId).toBe("other");
    expect(own.worker).not.toHaveProperty("BACKUP_R2_ACCESS_KEY_ID");
    expect(serverConfig(base, r2).backup).toBeUndefined();
    expect(() => serverConfig({ ...base, BACKUP_BUCKET: "backups" })).toThrow("BACKUP_BUCKET is set but R2_ACCOUNT_ID");
  });

  it.each([
    [{ STUDIO_HOST: "studio.example.com" }, "SERVER_HOST is not set"],
    [{ SERVER_HOST: "host" }, "STUDIO_HOST is not set"],
    [{ ...base, SERVER_HOST: "host; rm -rf /" }, "SERVER_HOST must be"],
    [{ ...base, SERVER_USER: "-oProxyCommand=x" }, "SERVER_USER is not a user name"],
    [{ ...base, STUDIO_HOST: "https://studio.example.com" }, "STUDIO_HOST must be a DNS name"],
    [{ ...base, STUDIO_HOST: "studio.example.com:8443" }, "STUDIO_HOST must be a DNS name"],
    [{ ...base, STUDIO_HOST: "203.0.113.7" }, "STUDIO_HOST must be a DNS name"],
    [{ ...base, STUDIO_HOST: "localhost" }, "STUDIO_HOST must be a DNS name"],
    [{ ...base, STUDIO_USER: "a b" }, "STUDIO_USER may only contain"],
    [{ ...base, SERVER_DIR: "relative/dir" }, "SERVER_DIR must be"],
    [{ ...base, SERVER_DIR: "/opt/../etc" }, "SERVER_DIR must be"],
    [{ ...base, SERVER_DIR: "/opt/my studio" }, "SERVER_DIR must be"],
    [{ ...base, WORKER_CONCURRENCY: "0" }, "WORKER_CONCURRENCY must be"],
    [{ ...base, BACKUP_BUCKET: "My Bucket", R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "b", R2_SECRET_ACCESS_KEY: "c" }, "BACKUP_BUCKET is not a bucket name"],
  ])("refuses %j", (env, message) => {
    expect(() => serverConfig(env as Record<string, string>)).toThrow(message);
  });
});

describe("the files written on the server", () => {
  const cfg = serverConfig({ ...base, WORKER_CONCURRENCY: "3" }, { GEMINI_API_KEY: "g" });
  const hash = "$2a$14$abcdefghijklmnopqrstuuK1Zx0Yw9vU8tS7rQ6pO5nM4lK3jI2hG";

  it("the stack's settings point at the server's folders and survive an env-file round trip, $ signs included", () => {
    const values = composeEnv(cfg, hash);
    expect(values).toEqual({
      STUDIO_HOST: "studio.example.com",
      STUDIO_USER: "studio",
      STUDIO_PASSWORD_HASH: hash,
      DATA_DIR: "/opt/flowchain/data",
      WORKER_ENV_FILE: "/opt/flowchain/worker.env",
      WORKER_CONCURRENCY: "3",
    });
    expect(parseEnv(composeEnvText(values))).toEqual(values);
    expect(composeEnvText({ A: "x$y z#1" })).toBe("A='x$y z#1'\n");
  });

  it("an env file refuses what it cannot carry", () => {
    expect(() => composeEnvText({ A: "it's" })).toThrow("A contains a quote");
    expect(() => composeEnvText({ A: "a\nB=c" })).toThrow("A contains");
    expect(() => composeEnvText({ "A B": "x" })).toThrow("not an environment variable name");
    expect(() => dockerEnvText({ A: "a\nB=c" })).toThrow("A contains a line break");
    expect(dockerEnvText({ A: "x'y" })).toBe("A=x'y\n");
  });

  it("the backup copies each data folder to the bucket with rclone and never deletes there", () => {
    const backup = { bucket: "backups", accountId: "acc", accessKeyId: "id", secretAccessKey: "secret" };
    const script = backupScript(cfg, backup);
    expect(script).toContain("for folder in runs brand-kits uploads; do");
    expect(script).toContain('-v /opt/flowchain/data/"$folder":/src:ro rclone/rclone:1');
    expect(script).toContain('copy /src r2:backups/flowchain-backup/"$folder"');
    expect(script).not.toMatch(/\bsync\b|--delete/);
    expect(backupEnv(backup)).toMatchObject({
      RCLONE_CONFIG_R2_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
      RCLONE_CONFIG_R2_ACCESS_KEY_ID: "id",
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: "secret",
    });
    const units = backupUnits(cfg);
    expect(units.service).toContain("ExecStart=/opt/flowchain/backup.sh");
    expect(units.service).toContain("After=docker.service");
    expect(units.timer).toContain("OnCalendar=*-*-* 03:30:00");
  });

  it("makes a different 24-character password every time", () => {
    const a = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(generatePassword()).not.toBe(a);
  });
});

describe("the commands run on the server", () => {
  const cfg = serverConfig(base);

  it("quotes only what a shell would misread", () => {
    expect(shellQuote("/opt/flowchain/app")).toBe("/opt/flowchain/app");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
    expect(shellQuote("")).toBe("''");
  });

  it("addresses the stack by its env file and Compose file", () => {
    expect(composeCommand(cfg, "ps")).toBe("docker compose --env-file /opt/flowchain/compose.env -f /opt/flowchain/app/deploy/compose.yaml ps");
    expect(upScript(cfg)).toContain("up -d --build --remove-orphans --wait --wait-timeout 3600\n");
    expect(upScript(cfg)).toContain("restart proxy\n");
  });

  it("installs Docker only when it is missing and creates every data folder", () => {
    const script = prepareScript(cfg);
    expect(script).toContain("if ! command -v docker >/dev/null 2>&1; then");
    expect(script).not.toMatch(/curl[^\n]*\|\s*sh/); // never a half-downloaded script
    execFileSync("sh", ["-n", "-c", script]); // parses
    for (const folder of ["runs", "brand-kits", "uploads", "redis", "caddy"]) expect(script).toContain(`/opt/flowchain/data/${folder}`);
  });

  it("replaces the code with the archive on stdin and leaves nothing of the old copy; a broken transfer changes nothing", async () => {
    const dir = await tempDir();
    const local = serverConfig({ ...base, SERVER_DIR: join(dir, "studio") });
    mkdirSync(local.dir, { recursive: true });
    const src = join(dir, "src");
    const archive = (files: Record<string, string>) => {
      execFileSync("rm", ["-rf", src]);
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(src, name, ".."), { recursive: true });
        writeFileSync(join(src, name), text);
      }
      return execFileSync("tar", ["-cf", "-", "-C", src, "."]);
    };
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    // through `sh -c '<script>'`, the way ssh hands it to the server
    const run = (script: string, input: Buffer) => execFileSync("sh", ["-c", `sh -c ${shellQuote(script)}`], { input, stdio: ["pipe", "pipe", "pipe"] });
    const app = paths(local).app;
    const listing = (folder: string) => execFileSync("ls", ["-A", folder], { encoding: "utf8" }).trim();

    const one = archive({ "deploy/compose.yaml": "one", "old.txt": "gone next time" });
    run(unpackScript(local, sha(one)), one);
    const two = archive({ "deploy/compose.yaml": "two" });
    run(unpackScript(local, sha(two)), two);
    expect(readFileSync(join(app, "deploy/compose.yaml"), "utf8")).toBe("two");
    expect(listing(app)).toBe("deploy");
    expect(listing(local.dir)).toBe("app");

    // cut off mid-file, cut off at a block boundary (which tar alone may accept as a whole archive), and empty
    const three = archive({ "deploy/compose.yaml": "three", "extra.txt": "x".repeat(4000) });
    for (const cut of [three.subarray(0, three.length - 3000), three.subarray(0, 1024), Buffer.alloc(0)]) {
      expect(() => run(unpackScript(local, sha(three)), cut)).toThrow(/checksum mismatch/);
      expect(readFileSync(join(app, "deploy/compose.yaml"), "utf8")).toBe("two");
      expect(listing(local.dir)).toBe("app");
    }
    expect(() => unpackScript(local, "not-a-checksum")).toThrow("SHA-256");
  });
});
