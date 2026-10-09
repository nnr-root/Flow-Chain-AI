import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
  backupEnv, backupScript, backupUnits, composeCommand, composeEnv, composeEnvText, databaseEnvs, dbEnvText, dbSecrets, dbUpScript, dockerEnvText,
  generatePassword, paths, prepareScript, psqlCommand, serverConfig, shellQuote, unpackScript, upScript,
} from "../../src/deploy/server.js";
import { tempDir } from "../helpers/media.js";

const base = { SERVER_HOST: "203.0.113.7", STUDIO_HOST: "Studio.Example.com" };

describe("serverConfig", () => {
  it("fills in the defaults and gives the worker this machine's keys", () => {
    const cfg = serverConfig(base, { GEMINI_API_KEY: "g", RUNPOD_API_KEY: " r ", EMPTY: " " });
    expect(cfg).toEqual({
      target: "root@203.0.113.7",
      dir: "/opt/flowchain",
      studioHost: "studio.example.com",
      studioUser: "studio",
      worker: { GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r" },
      accounts: false,
      web: {},
      billing: false,
    });
  });

  it("lets server.env replace and add worker settings, and keeps the deployment's own settings out of them", () => {
    const cfg = serverConfig(
      { ...base, SERVER_USER: "deploy", SERVER_DIR: "/srv/studio", STUDIO_USER: "me", WORKER_CONCURRENCY: "3", GEMINI_MODEL: "pro", RUNPOD_API_KEY: "server" },
      { RUNPOD_API_KEY: "local", GEMINI_MODEL: "flash" },
    );
    expect(cfg.target).toBe("deploy@203.0.113.7");
    expect(cfg.dir).toBe("/srv/studio");
    expect(cfg.concurrency).toBe(3);
    expect(cfg.worker).toEqual({ RUNPOD_API_KEY: "server", GEMINI_MODEL: "pro" });
  });

  it("keeps a local value off the server when server.env sets its name to nothing", () => {
    const cfg = serverConfig({ ...base, RUNPOD_API_KEY: "", R2_BUCKET: " " }, { RUNPOD_API_KEY: "local", R2_BUCKET: "local", GEMINI_API_KEY: "g" });
    expect(cfg.worker).toEqual({ GEMINI_API_KEY: "g" });
  });

  it("never passes on the settings of the hosted models the studio stopped using, wherever they are still written", () => {
    const cfg = serverConfig({ ...base, FAL_KEY: "server", PROVIDER_MODE: "fal" }, { FAL_KEY: "local", FAL_IMAGE_MODEL: "m", FAL_VIDEO_MODEL: "v", GEMINI_API_KEY: "g" });
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

describe("a studio with accounts", () => {
  const accounts = { STUDIO_ACCOUNTS: "1", SMTP_URL: "smtps://user:pass@smtp.example.com", MAIL_FROM: "Flow Chain <hello@example.com>" };
  const mail = { SMTP_URL: accounts.SMTP_URL, MAIL_FROM: accounts.MAIL_FROM };
  const r2 = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" };
  const secrets = { owner: "owner-password-0123456789", web: "web-password-0123456789ab", worker: "worker-password-012345678" };

  it("gives the web app the mail server and the bucket, and keeps every key that can spend with the worker", () => {
    const cfg = serverConfig(base, { ...accounts, ...r2, STUDIO_BUCKET: "studio", GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", STUDIO_USER_JOBS: "3" });
    expect(cfg.accounts).toBe(true);
    expect(cfg.web).toEqual({ ...mail, STUDIO_USER_JOBS: "3", STUDIO_BUCKET: "studio", ...r2 });
    for (const secret of ["GEMINI_API_KEY", "RUNPOD_API_KEY"]) {
      expect(cfg.web).not.toHaveProperty(secret);
      expect(cfg.worker).toHaveProperty(secret);
    }
    // the mail server is the web app's alone: the worker sends no email and signs nobody in
    for (const name of ["SMTP_URL", "MAIL_FROM", "STUDIO_ACCOUNTS"]) expect(cfg.worker).not.toHaveProperty(name);
    // without a bucket the web app has no use for the R2 keys either
    expect(serverConfig(base, { ...accounts, ...r2 }).web).toEqual(mail);
  });

  it("gives each service its own address of the database: the web app's cannot settle, the worker's is not the web app's", () => {
    const { web, worker } = databaseEnvs(secrets);
    expect(web).toEqual({ DATABASE_URL: "postgres://studio_web:web-password-0123456789ab@db:5432/flowchain" });
    expect(worker).toEqual({ DATABASE_URL: "postgres://studio_worker:worker-password-012345678@db:5432/flowchain" });
    // neither is the owner's, which no running service is ever given
    expect(JSON.stringify([web, worker])).not.toContain(secrets.owner);
    // and whatever this machine's .env says about a database never reaches the server
    const cfg = serverConfig(base, { ...accounts, DATABASE_URL: "postgres://postgres:local@127.0.0.1:54330/flowchain", POSTGRES_PASSWORD: "local", MAIL_DIR: "/tmp/mail" });
    for (const name of ["DATABASE_URL", "POSTGRES_PASSWORD", "MAIL_DIR"]) {
      expect(cfg.worker).not.toHaveProperty(name);
      expect(cfg.web).not.toHaveProperty(name);
    }
  });

  it("makes the database's passwords once, keeps them, and refuses a file that holds only some of them", () => {
    let n = 0;
    const made = dbSecrets({}, () => `generated-password-${++n}`);
    expect(made).toEqual({ secrets: { owner: "generated-password-1", web: "generated-password-2", worker: "generated-password-3" }, made: true });
    const stored = parseEnv(dbEnvText(made.secrets)) as Record<string, string>;
    expect(dbSecrets(stored, () => "never")).toEqual({ secrets: made.secrets, made: false });
    // new passwords for a database that already has others would lock every service out of it
    expect(() => dbSecrets({ POSTGRES_PASSWORD: "x" })).toThrow("some of the database's passwords but not all three");
    // what the real generator makes needs no quoting anywhere it travels
    expect(dbSecrets({}).secrets.web).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("puts the proxy without a login in front, because the studio asks every visitor itself, and starts the database", () => {
    const cfg = serverConfig(base, accounts);
    expect(composeEnv(cfg, undefined, secrets)).toEqual({
      STUDIO_HOST: "studio.example.com",
      // one word for the proxy's file and for what the web app insists on
      STUDIO_AUTH: "accounts",
      CADDYFILE: "Caddyfile.accounts",
      COMPOSE_PROFILES: "accounts",
      POSTGRES_PASSWORD: secrets.owner,
      DATA_DIR: "/opt/flowchain/data",
      WORKER_ENV_FILE: "/opt/flowchain/worker.env",
      WEB_ENV_FILE: "/opt/flowchain/web.env",
    });
    expect(() => composeEnv(cfg)).toThrow("needs its database's passwords");
    // a studio without accounts starts no database at all
    expect(composeEnv(serverConfig(base, {}), "$2a$14$hash")).not.toHaveProperty("COMPOSE_PROFILES");
  });

  it("starts the database alone, and reaches it only through its own container", () => {
    const cfg = serverConfig(base, accounts);
    expect(dbUpScript(cfg)).toContain("up -d --wait --wait-timeout 300 db\n");
    expect(psqlCommand(cfg)).toMatch(/ exec -T db psql -U postgres -d flowchain -v ON_ERROR_STOP=1 -q$/);
    expect(psqlCommand(cfg, { tuples: true, transaction: true })).toMatch(/ -q -At --single-transaction$/);
    // no password is ever on a command line: psql runs inside the container, as its owner
    expect(psqlCommand(cfg)).not.toMatch(/password|PGPASSWORD|postgres:\/\//i);
  });

  it("backs the database up as a copy the database itself took, and never its files as they are being written", () => {
    const cfg = serverConfig({ ...base, BACKUP_BUCKET: "studio-backup" }, { ...accounts, ...r2 });
    const script = backupScript(cfg, cfg.backup!);
    expect(script).toContain("exec -T db pg_dump -U postgres -Fc flowchain > /opt/flowchain/data/db-backup/flowchain.dump.tmp");
    expect(script).toContain("mv /opt/flowchain/data/db-backup/flowchain.dump.tmp /opt/flowchain/data/db-backup/flowchain.dump");
    expect(script).toContain("for folder in runs brand-kits uploads db-backup; do");
    expect(script).not.toMatch(/data\/postgres/);
    // the dump comes first, so a dump that fails fails the backup before anything is copied
    expect(script.indexOf("pg_dump")).toBeLessThan(script.indexOf("for folder"));
    // without accounts there is nothing to dump
    const plain = serverConfig({ ...base, BACKUP_BUCKET: "studio-backup" }, r2);
    expect(backupScript(plain, plain.backup!)).not.toContain("pg_dump");
  });

  it("gives the web app the bucket's own keys where it has them, not the pipeline's as well", () => {
    const cfg = serverConfig(base, { ...accounts, ...r2, STUDIO_BUCKET: "studio", STUDIO_R2_ACCESS_KEY_ID: "own-id", STUDIO_R2_SECRET_ACCESS_KEY: "own-secret" });
    expect(cfg.web).toMatchObject({ STUDIO_R2_ACCESS_KEY_ID: "own-id", STUDIO_R2_SECRET_ACCESS_KEY: "own-secret", R2_ACCOUNT_ID: "acc" });
    expect(cfg.web).not.toHaveProperty("R2_ACCESS_KEY_ID");
    expect(cfg.web).not.toHaveProperty("R2_SECRET_ACCESS_KEY");
    // the worker still has the pipeline's own
    expect(cfg.worker).toMatchObject({ R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" });
  });

  it("gives both processes the Stripe key, and the webhook's signing secret to the web app alone", () => {
    const stripe = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" };
    const cfg = serverConfig(base, { ...accounts, ...stripe, STRIPE_API_BASE: "http://127.0.0.1:3134", STRIPE_WEBHOOK_ENDPOINT: "we_1" });
    expect(cfg.billing).toBe(true);
    expect(cfg.web).toMatchObject(stripe);
    expect(cfg.worker.STRIPE_SECRET_KEY).toBe("sk_test_x");
    expect(cfg.worker).not.toHaveProperty("STRIPE_WEBHOOK_SECRET");
    // a test's stand-in address never reaches the server
    expect(cfg.worker).not.toHaveProperty("STRIPE_API_BASE");
    expect(cfg.web).not.toHaveProperty("STRIPE_API_BASE");
    // nor does setup's own note of which endpoint the secret is of
    expect(cfg.worker).not.toHaveProperty("STRIPE_WEBHOOK_ENDPOINT");
    expect(cfg.web).not.toHaveProperty("STRIPE_WEBHOOK_ENDPOINT");

    const without = serverConfig(base, { ...accounts, STRIPE_WEBHOOK_SECRET: "whsec_x" });
    expect(without.billing).toBe(false);
    expect(without.web).not.toHaveProperty("STRIPE_WEBHOOK_SECRET");
    expect(without.worker).not.toHaveProperty("STRIPE_WEBHOOK_SECRET");
    // off on the server alone
    expect(serverConfig({ ...base, STRIPE_SECRET_KEY: "" }, { ...accounts, ...stripe }).billing).toBe(false);
  });

  it("refuses payments without accounts, or without the webhook that confirms them", () => {
    expect(() => serverConfig(base, { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toThrow("payments need a studio with accounts");
    expect(() => serverConfig(base, { ...accounts, STRIPE_SECRET_KEY: "sk_test_x" })).toThrow("run npm run stripe:setup first");
  });

  it("turns accounts on or off by one setting, and off on the server alone when server.env says so", () => {
    expect(serverConfig(base, mail).accounts).toBe(false);
    const cfg = serverConfig({ ...base, STUDIO_ACCOUNTS: "0" }, accounts);
    expect(cfg.accounts).toBe(false);
    expect(cfg.web).toEqual({});
    expect(composeEnv(cfg, "$2a$14$hash")).toMatchObject({ STUDIO_AUTH: "proxy", CADDYFILE: "Caddyfile" });
    expect(() => serverConfig({ ...base, STUDIO_ACCOUNTS: "maybe" }, mail)).toThrow("STUDIO_ACCOUNTS must be 1");
  });

  it("refuses accounts without a mail server: an address nobody confirmed is nobody's", () => {
    expect(() => serverConfig(base, { STUDIO_ACCOUNTS: "1", MAIL_FROM: "x@example.com" })).toThrow("SMTP_URL is not set");
    expect(() => serverConfig(base, { STUDIO_ACCOUNTS: "1", SMTP_URL: "smtp://x" })).toThrow("MAIL_FROM is not set");
  });

  it("takes Google sign-in whole or not at all, and gives it to the web app alone", () => {
    const google = { GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "secret" };
    const cfg = serverConfig(base, { ...accounts, ...google });
    expect(cfg.web).toMatchObject(google);
    for (const name of Object.keys(google)) expect(cfg.worker).not.toHaveProperty(name);
    expect(() => serverConfig(base, { ...accounts, GOOGLE_CLIENT_ID: "id" })).toThrow("go together");
  });
});

describe("the files written on the server", () => {
  const cfg = serverConfig({ ...base, WORKER_CONCURRENCY: "3" }, { GEMINI_API_KEY: "g" });
  const hash = "$2a$14$abcdefghijklmnopqrstuuK1Zx0Yw9vU8tS7rQ6pO5nM4lK3jI2hG";

  it("the stack's settings point at the server's folders and survive an env-file round trip, $ signs included", () => {
    const values = composeEnv(cfg, hash);
    expect(values).toEqual({
      STUDIO_HOST: "studio.example.com",
      STUDIO_AUTH: "proxy",
      CADDYFILE: "Caddyfile",
      STUDIO_USER: "studio",
      STUDIO_PASSWORD_HASH: hash,
      DATA_DIR: "/opt/flowchain/data",
      WORKER_ENV_FILE: "/opt/flowchain/worker.env",
      WEB_ENV_FILE: "/opt/flowchain/web.env",
      WORKER_CONCURRENCY: "3",
    });
    expect(() => composeEnv(cfg)).toThrow("needs the proxy's login");
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
    expect(upScript(cfg)).toContain("docker image prune -f");
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
