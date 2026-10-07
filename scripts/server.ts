/**
 * npm run server:setup | server:deploy | server:backup — puts the studio on the server named in deploy/server.env
 * and keeps it there (3.2 spec §8.4). Everything happens over ssh; nothing is installed on this machine.
 */
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
  await remote(cfg, unpackScript(cfg), archive);
  console.log("Building and starting (the first build takes several minutes; a running job is allowed to finish first) …");
  await remote(cfg, upScript(cfg));
  const url = `https://${cfg.studioHost}`;
  // the first certificate takes a moment; 401 is the proxy asking for the login
  const deadline = Date.now() + 120_000;
  let answer = "no answer";
  while (Date.now() < deadline) {
    answer = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then((r) => String(r.status), (e: Error) => (e.cause instanceof Error ? e.cause.message : e.message));
    if (answer === "401") break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (answer === "401") console.log(`The studio is up: ${url} (user "${cfg.studioUser}")`);
  else console.warn(`The stack is running, but ${url} does not ask for the login yet (${answer}). Check that the DNS name points at the server and that ports 80 and 443 are open.`);
}

async function setup(cfg: ServerConfig, newPassword: boolean): Promise<void> {
  const p = paths(cfg);
  console.log(`Preparing ${cfg.target} (Docker, folders under ${cfg.dir}) …`);
  await remote(cfg, prepareScript(cfg));

  // the login: made once, and kept across later setups unless a new one is asked for
  const stored = parseEnv(await remoteText(cfg, `cat ${shellQuote(p.composeEnv)} 2>/dev/null || true`)) as Record<string, string>;
  let hash = newPassword ? undefined : stored.STUDIO_PASSWORD_HASH;
  let password: string | undefined;
  if (!hash) {
    password = generatePassword();
    // hashed on the server, read from stdin: the password is never on a command line
    hash = (await remoteText(cfg, "docker run --rm -i caddy:2 caddy hash-password", `${password}\n`)).trim().split("\n").at(-1) ?? "";
    if (!hash.startsWith("$2")) throw new Error("could not hash the login password on the server");
  }
  await writeRemote(cfg, p.composeEnv, composeEnvText(composeEnv(cfg, hash)));
  await writeRemote(cfg, p.workerEnv, composeEnvText(cfg.worker));
  console.log(`Wrote the stack's settings and the worker's ${Object.keys(cfg.worker).length} keys and settings.`);

  if (cfg.backup) {
    const units = backupUnits(cfg);
    await writeRemote(cfg, p.backupEnv, dockerEnvText(backupEnv(cfg.backup)));
    await writeRemote(cfg, p.backupScript, backupScript(cfg, cfg.backup), "700");
    await writeRemote(cfg, `/etc/systemd/system/${BACKUP_UNIT}.service`, units.service, "644");
    await writeRemote(cfg, `/etc/systemd/system/${BACKUP_UNIT}.timer`, units.timer, "644");
    await remote(cfg, `systemctl daemon-reload && systemctl enable --now ${BACKUP_UNIT}.timer`);
    console.log(`Nightly backup to the bucket "${cfg.backup.bucket}" is on (03:30, server time).`);
  } else {
    console.log("No BACKUP_BUCKET is set: the runs exist on the server's disk only.");
  }

  await deploy(cfg);
  if (password) {
    console.log(`\nLogin — shown this once, keep it somewhere safe:\n  user      ${cfg.studioUser}\n  password  ${password}`);
    console.log("(npm run server:setup -- --new-password makes a new one.)");
  }
}

async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  if (!["setup", "deploy", "backup"].includes(command ?? "")) {
    console.error("usage: npm run server:setup [-- --new-password] | npm run server:deploy | npm run server:backup");
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
