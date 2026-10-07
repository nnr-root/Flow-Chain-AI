import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compose, composeEnv, data, HOST, PASSWORD, PORT, repo, runs, USER, web } from "./stack";

/**
 * Brings up the real Compose stack on this machine — proxy with the login, web, worker, Redis — over a fixture
 * data folder, with the worker running the stand-in CLI: nothing in it can reach a provider.
 */
const sh = (cmd: string, args: string[], cwd = repo) => execFileSync(cmd, args, { cwd, env: composeEnv(), stdio: ["ignore", "inherit", "inherit"] });
const down = () => {
  try {
    sh("docker", [...compose, "down", "-v", "--remove-orphans"]);
  } catch {
    // nothing was up (or no env file yet)
  }
};

export default async function setup(): Promise<void> {
  down();
  try {
    await up();
  } catch (err) {
    // Playwright runs no teardown after a failed setup: do not leave the stack and its port behind
    if (!process.env.STACK_KEEP) down();
    throw err;
  }
}

async function up(): Promise<void> {
  try {
    rmSync(data, { recursive: true, force: true });
  } catch {
    // on Linux the containers' files belong to root: remove them the way they were made
    sh("docker", ["run", "--rm", "-v", `${join(data, "..")}:/e2e`, "caddy:2", "rm", "-rf", "/e2e/stack"]);
  }
  for (const dir of ["runs", "brand-kits", "uploads", "redis", "caddy"]) mkdirSync(join(data, dir), { recursive: true });
  sh(process.execPath, ["--import", "tsx", "e2e/make-fixtures.ts", runs], web);
  const hash = execFileSync("docker", ["run", "--rm", "caddy:2", "caddy", "hash-password", "--plaintext", PASSWORD], { encoding: "utf8" }).trim();
  // names the worker's key check looks for; the stand-in CLI never uses a value
  const keys = ["GEMINI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "FAL_KEY"];
  writeFileSync(join(data, "worker.env"), keys.map((k) => `${k}=stack-test\n`).join(""));
  writeFileSync(
    join(data, "compose.env"),
    [
      `STUDIO_HOST=${HOST}`,
      "STUDIO_SITE=:80", // plain HTTP on a port; the browser is told that the public name is this machine
      `STUDIO_USER=${USER}`,
      `STUDIO_PASSWORD_HASH='${hash}'`, // single quotes: a bcrypt hash is full of $ signs
      `DATA_DIR=${data}`,
      `WORKER_ENV_FILE=${join(data, "worker.env")}`,
      `STACK_PORT=${PORT}`,
      "",
    ].join("\n"),
  );
  // the files as a server gets them: a host name (so a certificate would be asked for), no test overrides
  const production = { ...composeEnv(), STUDIO_HOST: "studio.example.com", STUDIO_USER: USER, STUDIO_PASSWORD_HASH: hash, WORKER_ENV_FILE: join(data, "worker.env") };
  execFileSync("docker", ["compose", "-f", join(repo, "deploy/compose.yaml"), "config", "--quiet"], { cwd: repo, env: production, stdio: ["ignore", "inherit", "inherit"] });
  sh("docker", ["run", "--rm", "-e", "STUDIO_SITE=studio.example.com", "-e", `STUDIO_USER=${USER}`, "-e", `STUDIO_PASSWORD_HASH=${hash}`,
    "-v", `${join(repo, "deploy/Caddyfile")}:/etc/caddy/Caddyfile:ro`, "caddy:2", "caddy", "validate", "--config", "/etc/caddy/Caddyfile"]);
  sh("docker", [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "600"]);
  // the proxy has no health check of its own (every path asks for the login), so wait for it to ask
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await fetch(`http://localhost:${PORT}/`).then((r) => r.status, () => 0);
    if (status === 401) return;
    if (Date.now() > deadline) {
      sh("docker", [...compose, "logs", "--tail", "40", "proxy"]);
      throw new Error(`the proxy did not come up on port ${PORT} (last answer: ${status || "none"})`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
