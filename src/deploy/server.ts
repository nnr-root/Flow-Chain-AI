import { randomBytes } from "node:crypto";
import { posix } from "node:path";

/* The pure parts of `npm run server:*` (3.2 spec §8.4): settings, the files written on the server, command lines. */

/** Settings that describe the deployment itself; everything else in `deploy/server.env` is the worker's. */
const DEPLOY_KEYS = [
  "SERVER_HOST", "SERVER_USER", "SERVER_DIR", "STUDIO_HOST", "STUDIO_USER", "WORKER_CONCURRENCY",
  "BACKUP_BUCKET", "BACKUP_R2_ACCOUNT_ID", "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY",
];
/** Set by the Compose file for the server's own layout: a local value must never reach the worker. */
const COMPOSE_OWNED = [
  "RUNS_DIR", "BRAND_KITS_DIR", "STUDIO_UPLOADS_DIR", "REDIS_URL", "FLOWCHAIN_CLI", "FLOWCHAIN_ROOT",
  "STUDIO_SITE", "STUDIO_PASSWORD_HASH", "DATA_DIR", "WORKER_ENV_FILE", "NODE_ENV",
];

export type BackupConfig = { bucket: string; accountId: string; accessKeyId: string; secretAccessKey: string };
export type ServerConfig = {
  /** `user@host` for ssh. */
  target: string;
  /** The studio's folder on the server: `app/` (the code), `data/`, and the env files beside them. */
  dir: string;
  studioHost: string;
  studioUser: string;
  concurrency?: number;
  /** The worker's environment: the provider keys and settings. */
  worker: Record<string, string>;
  /** Absent when no backup bucket is set. */
  backup?: BackupConfig;
};

const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Reads the deployment's settings. `serverEnv` is `deploy/server.env`; `localEnv` is this machine's `.env`,
 * whose provider keys the worker gets unless `serverEnv` says otherwise.
 */
export function serverConfig(serverEnv: Record<string, string>, localEnv: Record<string, string> = {}): ServerConfig {
  const get = (name: string) => serverEnv[name]?.trim() || undefined;
  const need = (name: string): string => {
    const value = get(name);
    if (!value) throw new Error(`${name} is not set in deploy/server.env (see deploy/server.env.example)`);
    return value;
  };
  const host = need("SERVER_HOST");
  if (!HOST.test(host)) throw new Error(`SERVER_HOST must be a host name or an IP address, not "${host}"`);
  const user = get("SERVER_USER") ?? "root";
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error(`SERVER_USER is not a user name: "${user}"`);
  const dir = get("SERVER_DIR") ?? "/opt/flowchain";
  if (!/^\/[A-Za-z0-9_./-]+$/.test(dir) || posix.normalize(dir) !== dir || dir.endsWith("/")) {
    throw new Error(`SERVER_DIR must be a plain absolute path, not "${dir}"`);
  }
  const studioHost = need("STUDIO_HOST").toLowerCase();
  if (!HOST.test(studioHost) || !studioHost.includes(".") || /^[\d.]+$/.test(studioHost)) {
    throw new Error(`STUDIO_HOST must be a DNS name pointing at the server (a certificate is issued for it), not "${studioHost}"`);
  }
  const studioUser = get("STUDIO_USER") ?? "studio";
  if (!/^[A-Za-z0-9_.-]+$/.test(studioUser)) throw new Error(`STUDIO_USER may only contain letters, digits, "_", "." and "-"`);
  const rawConcurrency = get("WORKER_CONCURRENCY");
  if (rawConcurrency !== undefined && !/^[1-9]\d*$/.test(rawConcurrency)) throw new Error("WORKER_CONCURRENCY must be a whole number, 1 or more");

  const skip = new Set([...DEPLOY_KEYS, ...COMPOSE_OWNED]);
  const worker: Record<string, string> = {};
  for (const [key, value] of [...Object.entries(localEnv), ...Object.entries(serverEnv)]) {
    if (skip.has(key) || !value.trim()) continue;
    worker[key] = value.trim();
  }

  let backup: BackupConfig | undefined;
  const bucket = get("BACKUP_BUCKET");
  if (bucket) {
    const part = (name: string): string => {
      const value = get(`BACKUP_${name}`) ?? worker[name];
      if (!value) throw new Error(`BACKUP_BUCKET is set but ${name} (or BACKUP_${name}) is not`);
      return value;
    };
    backup = { bucket, accountId: part("R2_ACCOUNT_ID"), accessKeyId: part("R2_ACCESS_KEY_ID"), secretAccessKey: part("R2_SECRET_ACCESS_KEY") };
  }
  return {
    target: `${user}@${host}`, dir, studioHost, studioUser,
    ...(rawConcurrency ? { concurrency: Number(rawConcurrency) } : {}),
    worker,
    ...(backup ? { backup } : {}),
  };
}

/** Where things live on the server. */
export function paths(cfg: ServerConfig) {
  const at = (...parts: string[]) => posix.join(cfg.dir, ...parts);
  return {
    app: at("app"), data: at("data"),
    composeEnv: at("compose.env"), workerEnv: at("worker.env"), backupEnv: at("backup.env"), backupScript: at("backup.sh"),
    composeFile: at("app/deploy/compose.yaml"),
  };
}

export const DATA_FOLDERS = ["runs", "brand-kits", "uploads", "redis", "caddy"];
/** What a backup holds: everything a run, a brand kit or an upload is made of. Redis and certificates are not. */
export const BACKUP_FOLDERS = ["runs", "brand-kits", "uploads"];

/** One argument, safe inside a POSIX shell command line. */
export const shellQuote = (value: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);

/**
 * An env file for Docker Compose (`--env-file`, `env_file:`). Values are single-quoted, which Compose reads
 * literally: a bcrypt hash or a key with `$` in it is not mistaken for a variable.
 */
export function composeEnvText(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`not an environment variable name: "${key}"`);
      if (/['\n\r]/.test(value)) throw new Error(`${key} contains a quote or a line break, which an env file cannot carry`);
      return `${key}='${value}'\n`;
    })
    .join("");
}

/** An env file for `docker run --env-file`, which takes every line literally: no quotes. */
export function dockerEnvText(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (/[\n\r]/.test(value)) throw new Error(`${key} contains a line break, which an env file cannot carry`);
      return `${key}=${value}\n`;
    })
    .join("");
}

/** The stack's own settings: what `deploy/compose.yaml` interpolates. */
export function composeEnv(cfg: ServerConfig, passwordHash: string): Record<string, string> {
  const p = paths(cfg);
  return {
    STUDIO_HOST: cfg.studioHost,
    STUDIO_USER: cfg.studioUser,
    STUDIO_PASSWORD_HASH: passwordHash,
    DATA_DIR: p.data,
    WORKER_ENV_FILE: p.workerEnv,
    ...(cfg.concurrency ? { WORKER_CONCURRENCY: String(cfg.concurrency) } : {}),
  };
}

/** `docker compose …` on the server, for this stack. */
export function composeCommand(cfg: ServerConfig, ...args: string[]): string {
  const p = paths(cfg);
  return ["docker", "compose", "--env-file", p.composeEnv, "-f", p.composeFile, ...args].map(shellQuote).join(" ");
}

/** Prepares a fresh server: Docker, the folders. Safe to run again. */
export function prepareScript(cfg: ServerConfig): string {
  const p = paths(cfg);
  return [
    "set -eu",
    "if ! command -v docker >/dev/null 2>&1; then",
    "  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }",
    "  curl -fsSL https://get.docker.com | sh",
    "fi",
    "docker compose version >/dev/null",
    `mkdir -p ${[p.app, ...DATA_FOLDERS.map((f) => posix.join(p.data, f))].map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

/**
 * Replaces the code on the server with the archive on stdin (`git archive HEAD`): unpacked beside the old copy
 * and swapped in, so a broken transfer leaves the running version's files alone.
 */
export function unpackScript(cfg: ServerConfig): string {
  const app = shellQuote(paths(cfg).app);
  return [
    "set -eu",
    `rm -rf ${app}.new ${app}.old`,
    `mkdir -p ${app}.new`,
    `tar -xf - -C ${app}.new`,
    `if [ -e ${app} ]; then mv ${app} ${app}.old; fi`,
    `mv ${app}.new ${app}`,
    `rm -rf ${app}.old`,
    "",
  ].join("\n");
}

/** Builds and starts the stack and waits until it is healthy; a running job is given time to finish first. */
export function upScript(cfg: ServerConfig): string {
  return [
    "set -eu",
    composeCommand(cfg, "up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "3600"),
    // the proxy's config file is mounted from the code that was just replaced: start it on the new one
    composeCommand(cfg, "restart", "proxy"),
    "",
  ].join("\n");
}

/** rclone's settings for the backup bucket (Cloudflare R2), as `docker run --env-file` lines. */
export function backupEnv(backup: BackupConfig): Record<string, string> {
  return {
    RCLONE_CONFIG_R2_TYPE: "s3",
    RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
    RCLONE_CONFIG_R2_ENDPOINT: `https://${backup.accountId}.r2.cloudflarestorage.com`,
    RCLONE_CONFIG_R2_ACCESS_KEY_ID: backup.accessKeyId,
    RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: backup.secretAccessKey,
    RCLONE_CONFIG_R2_REGION: "auto",
    // a token limited to one bucket may not list or create buckets
    RCLONE_CONFIG_R2_NO_CHECK_BUCKET: "true",
  };
}

/**
 * The backup the timer runs: copies new and changed files to the bucket. It never deletes there, so a run
 * removed on the server by mistake is still in the backup.
 */
export function backupScript(cfg: ServerConfig, backup: BackupConfig): string {
  const p = paths(cfg);
  return [
    "#!/bin/sh",
    "# Written by `npm run server:setup`: copies the studio's data to the backup bucket.",
    "set -eu",
    `for folder in ${BACKUP_FOLDERS.join(" ")}; do`,
    `  docker run --rm --env-file ${shellQuote(p.backupEnv)} -v ${shellQuote(p.data)}/"$folder":/src:ro rclone/rclone:1 \\`,
    `    copy /src ${shellQuote(`r2:${backup.bucket}/flowchain-backup`)}/"$folder" --transfers 8`,
    "done",
    "",
  ].join("\n");
}

export const BACKUP_UNIT = "flowchain-backup";

/** The systemd service and nightly timer for the backup. */
export function backupUnits(cfg: ServerConfig): { service: string; timer: string } {
  return {
    service: ["[Unit]", "Description=Flow Chain studio backup", "", "[Service]", "Type=oneshot", `ExecStart=${paths(cfg).backupScript}`, ""].join("\n"),
    timer: [
      "[Unit]", "Description=Nightly Flow Chain studio backup", "",
      "[Timer]", "OnCalendar=*-*-* 03:30:00", "Persistent=true", "",
      "[Install]", "WantedBy=timers.target", "",
    ].join("\n"),
  };
}

/** A login password nobody chose: 24 characters, safe to paste anywhere. */
export const generatePassword = (): string => randomBytes(18).toString("base64url");
