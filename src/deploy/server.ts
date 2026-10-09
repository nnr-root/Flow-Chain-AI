import { randomBytes } from "node:crypto";
import { databaseUrl } from "./db.js";
import { posix } from "node:path";

/* The pure parts of `npm run server:*` (3.2 spec §8.4): settings, the files written on the server, command lines. */

/** Settings that describe the deployment itself; everything else in `deploy/server.env` is the worker's. */
const DEPLOY_KEYS = [
  "SERVER_HOST", "SERVER_USER", "SERVER_DIR", "STUDIO_HOST", "STUDIO_USER", "STUDIO_ACCOUNTS", "WORKER_CONCURRENCY",
  "BACKUP_BUCKET", "BACKUP_R2_ACCOUNT_ID", "BACKUP_R2_ACCESS_KEY_ID", "BACKUP_R2_SECRET_ACCESS_KEY",
];
/** Set by the Compose file for the server's own layout: a local value must never reach the worker. */
const COMPOSE_OWNED = [
  "RUNS_DIR", "BRAND_KITS_DIR", "STUDIO_UPLOADS_DIR", "REDIS_URL", "FLOWCHAIN_CLI", "FLOWCHAIN_ROOT",
  "STUDIO_SITE", "STUDIO_PASSWORD_HASH", "DATA_DIR", "WORKER_ENV_FILE", "WEB_ENV_FILE", "CADDYFILE", "STUDIO_AUTH", "NODE_ENV",
  // the server's database is its own container: its address and passwords are made on the server by server:setup
  "DATABASE_URL", "POSTGRES_PASSWORD", "COMPOSE_PROFILES",
];
/** What stays on the owner's machine: nothing on the server needs it. */
const OWNER_ONLY = ["STRIPE_WEBHOOK_ENDPOINT", "MAIL_DIR"];
/** Where a test's stand-in Stripe is: the server only ever talks to the real one. */
const TEST_ONLY = ["STRIPE_API_BASE"];
/**
 * Settings of the hosted picture models and voice the studio no longer buys from (phase 5 spec §5). An owner's `.env`
 * may still carry them; a key nothing uses must not be handed to a process, on a server or on this machine.
 */
export const RETIRED_KEYS = ["FAL_KEY", "FAL_IMAGE_MODEL", "FAL_VIDEO_MODEL", "PROVIDER_MODE", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL"];
/**
 * What the web app gets in a studio with accounts: the mail server and Google sign-in (its alone: the worker
 * sends no email and signs nobody in), the job limit, and the bucket. Its address of the database is added on
 * the server (`databaseEnvs`). Everything else — the provider keys, and above all the database address that
 * can settle credit — is the worker's alone.
 */
const WEB_ONLY_KEYS = ["SMTP_URL", "MAIL_FROM", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const WEB_KEYS = [...WEB_ONLY_KEYS, "STUDIO_USER_JOBS"];
const WEB_BUCKET_KEYS = [
  "STUDIO_BUCKET", "STUDIO_S3_ENDPOINT", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
  "STUDIO_R2_ACCOUNT_ID", "STUDIO_R2_ACCESS_KEY_ID", "STUDIO_R2_SECRET_ACCESS_KEY",
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
  /** A studio with accounts (`STUDIO_ACCOUNTS=1`): visitors sign in at the studio itself, and the proxy has no login. */
  accounts: boolean;
  /** The web app's environment: empty without accounts. */
  web: Record<string, string>;
  /** The studio takes payments (`STRIPE_SECRET_KEY`, which needs accounts). */
  billing: boolean;
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
  if (!HOST.test(host)) throw new Error(`SERVER_HOST must be a host name or an IPv4 address, not "${host}"`);
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

  const skip = new Set([...DEPLOY_KEYS, ...COMPOSE_OWNED, ...OWNER_ONLY, ...TEST_ONLY, ...RETIRED_KEYS]);
  const worker: Record<string, string> = {};
  for (const [key, value] of Object.entries(localEnv)) {
    if (!skip.has(key) && value.trim()) worker[key] = value.trim();
  }
  for (const [key, value] of Object.entries(serverEnv)) {
    if (skip.has(key)) continue;
    // set to nothing in server.env: the server does without this machine's value
    if (value.trim()) worker[key] = value.trim();
    else delete worker[key];
  }

  let backup: BackupConfig | undefined;
  const bucket = get("BACKUP_BUCKET");
  if (bucket) {
    const part = (name: string): string => {
      const value = get(`BACKUP_${name}`) ?? worker[name];
      if (!value) throw new Error(`BACKUP_BUCKET is set but ${name} (or BACKUP_${name}) is not`);
      return value;
    };
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error(`BACKUP_BUCKET is not a bucket name: "${bucket}"`);
    backup = { bucket, accountId: part("R2_ACCOUNT_ID"), accessKeyId: part("R2_ACCESS_KEY_ID"), secretAccessKey: part("R2_SECRET_ACCESS_KEY") };
  }
  const rawAccounts = (get("STUDIO_ACCOUNTS") ?? localEnv.STUDIO_ACCOUNTS?.trim() ?? "").toLowerCase();
  if (rawAccounts && !["1", "true", "yes", "0", "false", "no"].includes(rawAccounts)) throw new Error("STUDIO_ACCOUNTS must be 1 (the studio has accounts) or 0");
  const accounts = ["1", "true", "yes"].includes(rawAccounts);
  const web: Record<string, string> = {};
  if (accounts) {
    // Without a mailbox to reach, an address is taken at its word: fine on the owner's own machine, and on a
    // server how a welcome credit is farmed and how someone signs up as somebody else. So it is not offered.
    for (const name of ["SMTP_URL", "MAIL_FROM"]) {
      if (!worker[name]) throw new Error(`STUDIO_ACCOUNTS is on but ${name} is not set: a studio with accounts confirms every address by email (see deploy/server.env.example)`);
    }
    if (!!worker.GOOGLE_CLIENT_ID !== !!worker.GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together: set both for Google sign-in, or neither");
    for (const name of [...WEB_KEYS, ...(worker.STUDIO_BUCKET ? WEB_BUCKET_KEYS : [])]) {
      // the bucket's own keys, where it has them, are the ones the web app uses: the pipeline's are then not its business
      if (worker[`STUDIO_${name}`] && name.startsWith("R2_")) continue;
      if (worker[name]) web[name] = worker[name];
    }
  }
  for (const name of WEB_ONLY_KEYS) delete worker[name];
  // Payments (3.4). Both processes talk to Stripe: the web app opens checkouts, the worker reads what was paid.
  // The webhook's signing secret is the web app's alone — the worker never sees a webhook, only an event's id.
  const billing = !!worker.STRIPE_SECRET_KEY;
  const webhookSecret = worker.STRIPE_WEBHOOK_SECRET;
  delete worker.STRIPE_WEBHOOK_SECRET;
  if (billing) {
    if (!accounts) throw new Error("STRIPE_SECRET_KEY is set but STUDIO_ACCOUNTS is not on: payments need a studio with accounts");
    if (!webhookSecret) throw new Error("STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not: run npm run stripe:setup first (it creates the webhook and writes its secret to .env)");
    web.STRIPE_SECRET_KEY = worker.STRIPE_SECRET_KEY;
    web.STRIPE_WEBHOOK_SECRET = webhookSecret;
  }
  return {
    target: `${user}@${host}`, dir, studioHost, studioUser,
    ...(rawConcurrency ? { concurrency: Number(rawConcurrency) } : {}),
    worker, accounts, web, billing,
    ...(backup ? { backup } : {}),
  };
}

/** Where things live on the server. */
export function paths(cfg: ServerConfig) {
  const at = (...parts: string[]) => posix.join(cfg.dir, ...parts);
  return {
    app: at("app"), data: at("data"), archive: at("app.tar"),
    composeEnv: at("compose.env"), workerEnv: at("worker.env"), webEnv: at("web.env"), backupEnv: at("backup.env"), backupScript: at("backup.sh"),
    dbEnv: at("db.env"),
    composeFile: at("app/deploy/compose.yaml"),
  };
}

export const DATA_FOLDERS = ["runs", "brand-kits", "uploads", "redis", "caddy", "postgres", "db-backup"];
/**
 * What a backup holds: everything a run, a brand kit or an upload is made of, and (with accounts) the night's
 * copy of the database. Redis, certificates and the database's own files are not: a copy of files that are
 * being written is not a backup.
 */
export const BACKUP_FOLDERS = ["runs", "brand-kits", "uploads"];
export const DB_BACKUP_FOLDER = "db-backup";

/** The database's three passwords: made on the first setup, kept on the server (`db.env`), reused ever after. */
export type DbSecrets = { owner: string; web: string; worker: string };

/** A password nobody chose, safe wherever it travels (letters, digits, - and _ only). */
export const generateDbPassword = (): string => randomBytes(24).toString("base64url");

/** The secrets a server already has, or new ones. A file that holds only some of them is not guessed at. */
export function dbSecrets(stored: Record<string, string>, generate: () => string = generateDbPassword): { secrets: DbSecrets; made: boolean } {
  const have = { owner: stored.POSTGRES_PASSWORD?.trim(), web: stored.DB_WEB_PASSWORD?.trim(), worker: stored.DB_WORKER_PASSWORD?.trim() };
  const count = Object.values(have).filter(Boolean).length;
  if (count === 3) return { secrets: have as DbSecrets, made: false };
  if (count > 0) throw new Error("the server's db.env holds some of the database's passwords but not all three: it was edited by hand; restore it, or remove it together with the data/postgres folder to start an empty database");
  return { secrets: { owner: generate(), web: generate(), worker: generate() }, made: true };
}

export const dbEnvText = (secrets: DbSecrets): string =>
  composeEnvText({ POSTGRES_PASSWORD: secrets.owner, DB_WEB_PASSWORD: secrets.web, DB_WORKER_PASSWORD: secrets.worker });

/** Each service's own address of the database, inside the stack's private network. */
export function databaseEnvs(secrets: DbSecrets): { web: Record<string, string>; worker: Record<string, string> } {
  return {
    web: { DATABASE_URL: databaseUrl("studio_web", secrets.web, "db:5432") },
    worker: { DATABASE_URL: databaseUrl("studio_worker", secrets.worker, "db:5432") },
  };
}

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

/**
 * The stack's own settings: what `deploy/compose.yaml` interpolates. Without accounts the proxy asks for the one
 * login (`passwordHash`); with them it has none and the studio asks every visitor to sign in.
 */
export function composeEnv(cfg: ServerConfig, passwordHash?: string, db?: DbSecrets): Record<string, string> {
  const p = paths(cfg);
  if (!cfg.accounts && !passwordHash) throw new Error("a studio without accounts needs the proxy's login");
  if (cfg.accounts && !db) throw new Error("a studio with accounts needs its database's passwords");
  return {
    STUDIO_HOST: cfg.studioHost,
    // one word decides both the proxy's file and what the web app insists on: they cannot disagree
    ...(cfg.accounts
      ? { STUDIO_AUTH: "accounts", CADDYFILE: "Caddyfile.accounts", COMPOSE_PROFILES: "accounts", POSTGRES_PASSWORD: db!.owner }
      : { STUDIO_AUTH: "proxy", CADDYFILE: "Caddyfile", STUDIO_USER: cfg.studioUser, STUDIO_PASSWORD_HASH: passwordHash! }),
    DATA_DIR: p.data,
    WORKER_ENV_FILE: p.workerEnv,
    WEB_ENV_FILE: p.webEnv,
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
    // downloaded whole before it runs: a broken download must not run half a script
    "  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh",
    "  sh /tmp/get-docker.sh",
    "  rm -f /tmp/get-docker.sh",
    "fi",
    'docker compose version >/dev/null 2>&1 || { echo "Docker is installed but its compose plugin is missing (docker compose version fails)" >&2; exit 1; }',
    `mkdir -p ${[p.app, ...DATA_FOLDERS.map((f) => posix.join(p.data, f))].map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

/**
 * Replaces the code on the server with the archive on stdin (`git archive HEAD`). The archive is stored and its
 * checksum compared before anything is unpacked, and the new copy is unpacked beside the old one and swapped
 * in: a transfer that breaks, at whatever byte, leaves the running version's files alone.
 */
export function unpackScript(cfg: ServerConfig, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("the archive's checksum must be a SHA-256 in hex");
  const p = paths(cfg);
  const app = shellQuote(p.app);
  const archive = shellQuote(p.archive);
  return [
    "set -eu",
    `rm -rf ${app}.new ${app}.old ${archive}`,
    `cat > ${archive}`,
    // sha256sum on Linux, shasum on macOS (the tests run there)
    `sum=$( (sha256sum ${archive} 2>/dev/null || shasum -a 256 ${archive}) | cut -d" " -f1)`,
    `if [ "$sum" != ${sha256} ]; then rm -f ${archive}; echo "the code arrived incomplete (checksum mismatch); nothing was changed" >&2; exit 1; fi`,
    `mkdir -p ${app}.new`,
    `tar -xf ${archive} -C ${app}.new`,
    `rm -f ${archive}`,
    `if [ -e ${app} ]; then mv ${app} ${app}.old; fi`,
    `mv ${app}.new ${app}`,
    `rm -rf ${app}.old`,
    "",
  ].join("\n");
}

/** `psql` inside the database's own container, as its owner, reading SQL from stdin. The password never leaves the server. */
export function psqlCommand(cfg: ServerConfig, opts: { tuples?: boolean; transaction?: boolean } = {}): string {
  return composeCommand(cfg, ...psqlArgs(opts));
}

/** What follows `docker compose` to run `psql` in the database's container (the stack test uses the same words). */
export const psqlArgs = (opts: { tuples?: boolean; transaction?: boolean } = {}): string[] =>
  ["exec", "-T", "db", "psql", "-U", "postgres", "-d", "flowchain", "-v", "ON_ERROR_STOP=1", "-q", ...(opts.tuples ? ["-At"] : []), ...(opts.transaction ? ["--single-transaction"] : [])];

/** Starts the database alone and waits until it answers: migrations are applied before anything that uses it starts. */
export function dbUpScript(cfg: ServerConfig): string {
  return ["set -eu", composeCommand(cfg, "up", "-d", "--wait", "--wait-timeout", "300", "db"), ""].join("\n");
}

/** Builds and starts the stack and waits until it is healthy; a running job is given time to finish first. */
export function upScript(cfg: ServerConfig): string {
  return [
    "set -eu",
    composeCommand(cfg, "up", "-d", "--build", "--remove-orphans", "--wait", "--wait-timeout", "3600"),
    // the proxy's config file is mounted from the code that was just replaced: start it on the new one
    composeCommand(cfg, "restart", "proxy"),
    // every build leaves the previous images behind, on the disk the runs need
    "docker image prune -f >/dev/null",
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
  const folders = [...BACKUP_FOLDERS, ...(cfg.accounts ? [DB_BACKUP_FOLDER] : [])];
  const dump = shellQuote(posix.join(p.data, DB_BACKUP_FOLDER, "flowchain.dump"));
  return [
    "#!/bin/sh",
    "# Written by `npm run server:setup`: copies the studio's data to the backup bucket.",
    "set -eu",
    // A consistent copy of the database, taken by the database itself; written whole before it replaces last
    // night's, so a dump that fails half-way leaves the good one in place (and fails the backup).
    ...(cfg.accounts
      ? [
          `${composeCommand(cfg, "exec", "-T", "db", "pg_dump", "-U", "postgres", "-Fc", "flowchain")} > ${dump}.tmp`,
          `mv ${dump}.tmp ${dump}`,
        ]
      : []),
    `for folder in ${folders.join(" ")}; do`,
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
    service: ["[Unit]", "Description=Flow Chain studio backup", "After=docker.service", "Requires=docker.service", "", "[Service]", "Type=oneshot", `ExecStart=${paths(cfg).backupScript}`, ""].join("\n"),
    timer: [
      "[Unit]", "Description=Nightly Flow Chain studio backup", "",
      "[Timer]", "OnCalendar=*-*-* 03:30:00", "Persistent=true", "",
      "[Install]", "WantedBy=timers.target", "",
    ].join("\n"),
  };
}

/** A login password nobody chose: 24 characters, safe to paste anywhere. */
export const generatePassword = (): string => randomBytes(18).toString("base64url");
