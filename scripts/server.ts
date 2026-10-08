/**
 * npm run server:setup | server:deploy | server:backup — puts the studio on the server named in deploy/server.env
 * and keeps it there (3.2 spec §8.4). Everything happens over ssh; nothing is installed on this machine.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { execa } from "execa";
import {
  BACKUP_UNIT, backupEnv, backupScript, backupUnits, composeEnv, composeEnvText, dockerEnvText, generatePassword, paths,
  prepareScript, serverConfig, type ServerConfig, shellQuote, unpackScript, upScript,
} from "../src/deploy/server.js";

const SERVER_ENV = "deploy/server.env";

function readEnv(path: string, required: boolean): Record<string, string> {
  try {
    return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  } catch (err) {
    if (!required) return {};
    throw new Error(`cannot read ${path}: copy deploy/server.env.example to it and fill it in`, { cause: err });
  }
}

const SSH = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30"];

/** Runs a shell script on the server; its output is shown as it comes. */
async function remote(cfg: ServerConfig, script: string, input?: string | Uint8Array): Promise<void> {
  await execa("ssh", [...SSH, cfg.target, `sh -c ${shellQuote(script)}`], { input: input ?? "", stdout: "inherit", stderr: "inherit" });
}

/** Runs a command on the server and returns what it printed. */
async function remoteText(cfg: ServerConfig, script: string, input = ""): Promise<string> {
  return (await execa("ssh", [...SSH, cfg.target, `sh -c ${shellQuote(script)}`], { input, stderr: "inherit" })).stdout;
}

/** Writes a file on the server that only its owner can read (keys, hashes). */
async function writeRemote(cfg: ServerConfig, path: string, text: string, mode = "600"): Promise<void> {
  const file = shellQuote(path);
  await remote(cfg, `umask 077 && cat > ${file}.tmp && chmod ${mode} ${file}.tmp && mv ${file}.tmp ${file}`, text);
}

async function deploy(cfg: ServerConfig): Promise<void> {
  if ((await execa("git", ["status", "--porcelain"])).stdout.trim()) {
    console.warn("Note: uncommitted changes are not deployed; the server gets the last commit.");
  }
  const commit = (await execa("git", ["rev-parse", "--short", "HEAD"])).stdout.trim();
  console.log(`Copying commit ${commit} to ${cfg.target}:${paths(cfg).app} …`);
  const archive = (await execa("git", ["archive", "--format=tar", "HEAD"], { encoding: "buffer", maxBuffer: 1024 ** 3 })).stdout;
  await remote(cfg, unpackScript(cfg, createHash("sha256").update(archive).digest("hex")), archive);
  console.log("Building and starting (the first build takes several minutes; a running job is allowed to finish first) …");
  await remote(cfg, upScript(cfg));
  const url = `https://${cfg.studioHost}`;
  // The first certificate takes a moment. What is waited for is the studio REFUSING someone who is not signed in:
  // 401 from the proxy's login, or — with accounts — 401 from the studio's own API for a request without a session.
  const probe = cfg.accounts ? `${url}/api/runs` : url;
  const deadline = Date.now() + 120_000;
  let answer = "no answer";
  while (Date.now() < deadline) {
    answer = await fetch(probe, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).then((r) => String(r.status), (e: Error) => (e.cause instanceof Error ? e.cause.message : e.message));
    if (answer === "401" || answer === "200") break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (answer === "401") console.log(cfg.accounts ? `The studio is up: ${url} (sign up there, then add credit with npm run studio:grant)` : `The studio is up: ${url} (user "${cfg.studioUser}")`);
  else if (answer === "200") throw new Error(`${probe} answers WITHOUT asking who is there: the studio is open to anyone. Stop it (ssh ${cfg.target} and run: docker compose -p flowchain down) and run npm run server:setup again.`);
  else console.warn(`The stack is running, but ${url} does not answer as expected yet (${answer}). Check that the DNS name points at the server and that ports 80 and 443 are open.`);
}

async function setup(cfg: ServerConfig, newPassword: boolean): Promise<void> {
  const p = paths(cfg);
  // everything that can be refused is checked before the server is touched
  const workerEnvText = composeEnvText(cfg.worker);
  const webEnvText = composeEnvText(cfg.web);
  const backupEnvText = cfg.backup ? dockerEnvText(backupEnv(cfg.backup)) : "";
  const names = Object.keys(cfg.worker).sort();
  if (names.length === 0) console.warn("Warning: no provider keys or settings were found in .env or deploy/server.env; the worker will not be able to generate anything.");
  else console.log(`The worker gets: ${names.join(", ")}`);
  if (cfg.accounts) console.log(`The web app gets: ${Object.keys(cfg.web).sort().join(", ")}`);
  console.log(`Preparing ${cfg.target} (Docker, folders under ${cfg.dir}) …`);
  await remote(cfg, prepareScript(cfg));

  // the login: made once, and kept across later setups unless a new one is asked for
  const stored = parseEnv(await remoteText(cfg, `cat ${shellQuote(p.composeEnv)} 2>/dev/null || true`)) as Record<string, string>;
  let hash: string | undefined;
  let password: string | undefined;
  if (cfg.accounts) {
    console.log("This studio has accounts (SUPABASE_URL): visitors sign in at the studio, and the proxy asks for no login.");
    if (!cfg.worker.STUDIO_BUCKET) console.warn("Warning: STUDIO_BUCKET is not set: runs and uploads will exist on the server's disk only.");
  } else {
    hash = newPassword ? undefined : stored.STUDIO_PASSWORD_HASH;
    if (!hash) {
      password = generatePassword();
      // hashed on the server, read from stdin: the password is never on a command line
      hash = (await remoteText(cfg, "docker run --rm -i caddy:2 caddy hash-password", `${password}\n`)).trim().split("\n").at(-1) ?? "";
      if (!hash.startsWith("$2")) throw new Error("could not hash the login password on the server");
    }
  }
  // The web app's settings first, the stack's last: the stack's file names the proxy without a login, and that
  // must never be in place before the web app has what makes it ask for one.
  await writeRemote(cfg, p.webEnv, webEnvText);
  await writeRemote(cfg, p.workerEnv, workerEnvText);
  await writeRemote(cfg, p.composeEnv, composeEnvText(composeEnv(cfg, hash)));
  // shown as soon as it is stored: if a later step fails, the login is not lost with it
  if (password) {
    console.log(`\nLogin — shown this once, keep it somewhere safe:\n  user      ${cfg.studioUser}\n  password  ${password}`);
    console.log("(npm run server:setup -- --new-password makes a new one.)\n");
  }
  console.log("Wrote the stack's settings and the worker's keys.");

  if (cfg.backup) {
    const units = backupUnits(cfg);
    await writeRemote(cfg, p.backupEnv, backupEnvText);
    await writeRemote(cfg, p.backupScript, backupScript(cfg, cfg.backup), "700");
    await writeRemote(cfg, `/etc/systemd/system/${BACKUP_UNIT}.service`, units.service, "644");
    await writeRemote(cfg, `/etc/systemd/system/${BACKUP_UNIT}.timer`, units.timer, "644");
    await remote(cfg, `systemctl daemon-reload && systemctl enable --now ${BACKUP_UNIT}.timer`);
    console.log(`Nightly backup to the bucket "${cfg.backup.bucket}" is on (03:30, server time).`);
  } else {
    // a timer from an earlier setup must not go on running a backup that is no longer configured
    await remote(cfg, `systemctl disable --now ${BACKUP_UNIT}.timer >/dev/null 2>&1 || true`);
    console.log("No BACKUP_BUCKET is set: the runs exist on the server's disk only.");
  }

  await deploy(cfg);
  if (cfg.backup) {
    // once now, so a wrong bucket or key shows today and not at 03:30
    console.log("Running the backup once …");
    await remote(cfg, shellQuote(p.backupScript)).then(
      () => console.log("Backup works."),
      () => console.warn("Warning: the backup failed (see above). Check BACKUP_BUCKET and the R2 keys, then run npm run server:setup again."),
    );
  }
  if (password) console.log(`\nReminder: the login is user "${cfg.studioUser}" with the password shown above.`);
}

async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  if (!["setup", "deploy", "backup"].includes(command ?? "")) {
    console.error("usage: npm run server:setup [-- --new-password] | npm run server:deploy | npm run server:backup");
    process.exit(2);
  }
  const unknown = flags.filter((flag) => !(command === "setup" && flag === "--new-password"));
  if (unknown.length > 0) {
    console.error(`unknown option ${unknown.join(" ")}`);
    process.exit(2);
  }
  const cfg = serverConfig(readEnv(SERVER_ENV, true), readEnv(".env", false));
  if (command === "setup") await setup(cfg, flags.includes("--new-password"));
  else if (command === "deploy") await deploy(cfg);
  else {
    if (!cfg.backup) throw new Error("BACKUP_BUCKET is not set in deploy/server.env; set it and run npm run server:setup");
    await remote(cfg, shellQuote(paths(cfg).backupScript));
    console.log("Backup finished.");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
