/**
 * npm run studio:local [-- --no-stripe] [-- --no-open]: the whole studio on this machine with one command — the
 * local database (started if it is not running), a queue, the worker and the web app, and Stripe's test mode
 * when a test key is in .env and the Stripe CLI is installed. Ctrl+C stops all of it.
 *
 * npm run studio:local -- grant <email> <usd>: adds credit to an account in the LOCAL database.
 *
 * It never touches a hosted project or the real bucket (src/deploy/local.ts). The worker does have this
 * machine's provider keys: a video you generate is really generated, and really paid for, up to the amount you
 * approve on its button.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { execa } from "execa";
import { EVENT_TYPES } from "../src/billing/stripe.js";
import { localEnvs } from "../src/deploy/local.js";

const PORT = 3131;
const REDIS_PORT = 6399;
const URL = `http://127.0.0.1:${PORT}`;
const children: ChildProcess[] = [];

function readEnv(): Record<string, string> {
  try {
    return parseEnv(readFileSync(".env", "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The local stack's address and keys; the stack is started when it is not running (the first time takes minutes). */
async function localSupabase(): Promise<{ url: string; anonKey: string; serviceKey: string }> {
  const status = () => execa("npx", ["supabase", "status", "-o", "env"], { reject: false });
  let r = await status();
  if (r.exitCode !== 0) {
    console.log("Starting the local database (Docker) …");
    await execa("npm", ["run", "-s", "db:start"], { stdio: "inherit" });
    r = await status();
  }
  const value = (name: string) => new RegExp(`^${name}="?([^"\n]+)"?$`, "m").exec(String(r.stdout))?.[1] ?? "";
  const found = { url: value("API_URL"), anonKey: value("ANON_KEY"), serviceKey: value("SERVICE_ROLE_KEY") };
  if (!found.url || !found.anonKey || !found.serviceKey) throw new Error("the local database is not running and could not be started: is Docker running? (npm run db:start)");
  return found;
}

/** Starts a process whose output goes to this terminal under a name; it is stopped with everything else. */
function start(name: string, command: string, args: string[], opts: { cwd?: string; env: Record<string, string>; quiet?: boolean }): ChildProcess {
  // nothing of this shell's own settings: each process gets exactly what it is meant to have
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.env };
  const child = spawn(command, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const say = (chunk: Buffer) => {
    if (opts.quiet) return;
    // (a signing secret that a tool prints is not for the screen)
    for (const line of chunk.toString().split("\n")) if (line.trim()) console.log(`[${name}] ${line.replace(/\b(whsec|sk|rk)_[A-Za-z0-9_]+/g, "$1_…")}`);
  };
  child.stdout?.on("data", say);
  child.stderr?.on("data", say);
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`\n${name} stopped (exit ${code ?? "by a signal"}); stopping the rest.`);
      void stop(1);
    }
  });
  children.push(child);
  return child;
}

let stopping = false;
async function stop(code: number): Promise<never> {
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  process.exit(code);
}

async function grant(args: string[]): Promise<void> {
  const [email, amount] = args;
  const usd = Number(amount);
  if (!email?.includes("@") || !Number.isFinite(usd) || usd === 0) throw new Error("usage: npm run studio:local -- grant <email> <usd>");
  const supabase = await localSupabase();
  localEnvs({ env: {}, supabase, redisUrl: "" }); // (refuses anything but the local database)
  const db = createClient(supabase.url, supabase.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.rpc("grant_credit", { p_email: email, p_amount_usd: usd, p_note: "local" });
  if (error) throw new Error(error.message === "not_found" ? `no account with the address ${email} in the local database: sign up at ${URL} first` : error.message);
  console.log(`${email} now has $${Number(data).toFixed(2)} in the local database.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "grant") return grant(argv.slice(1));
  const unknown = argv.filter((a) => !["--no-stripe", "--no-open"].includes(a));
  if (unknown.length > 0) {
    console.error(`unknown option ${unknown.join(" ")}\nusage: npm run studio:local [-- --no-stripe] [-- --no-open] | npm run studio:local -- grant <email> <usd>`);
    process.exit(2);
  }
  const env = readEnv();
  const supabase = await localSupabase();

  // Payments: Stripe's test mode, with the Stripe CLI passing its events on to this machine.
  let listenSecret: string | undefined;
  const testKey = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY?.trim() ?? "");
  if (!argv.includes("--no-stripe") && testKey) {
    const asked = await execa("stripe", ["listen", "--print-secret"], { reject: false }).catch(() => null);
    const secret = /whsec_[A-Za-z0-9]+/.exec(String(asked?.stdout ?? ""))?.[0];
    if (secret) listenSecret = secret;
    else console.log("Payments are left out: the Stripe CLI is not installed or not logged in (stripe login).");
  } else if (!argv.includes("--no-stripe")) console.log("Payments are left out: .env has no Stripe test key (sk_test_…).");

  const redisDir = join(tmpdir(), `flowchain-local-redis-${process.pid}`);
  mkdirSync(redisDir, { recursive: true });
  const { web, worker, billing } = localEnvs({ env, supabase, redisUrl: `redis://127.0.0.1:${REDIS_PORT}`, stripeListenSecret: listenSecret });

  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  start("queue", "redis-server", ["--port", String(REDIS_PORT), "--bind", "127.0.0.1", "--dir", redisDir, "--save", ""], { env: {}, quiet: true });
  if (billing) start("stripe", "stripe", ["listen", "--events", EVENT_TYPES.join(","), "--forward-to", `${URL}/api/stripe/webhook`], { env: {} });
  start("worker", "node", ["--import", "tsx", "worker/main.ts"], { cwd: "web", env: worker });
  start("web", "npx", ["next", "dev", "--webpack", "-H", "127.0.0.1", "-p", String(PORT)], { cwd: "web", env: web });

  const deadline = Date.now() + 120_000;
  for (;;) {
    const up = await fetch(`${URL}/api/ping`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    if (up) break;
    if (Date.now() > deadline) {
      console.error("The studio did not come up within two minutes; see the lines above.");
      return void stop(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`
────────────────────────────────────────────────────────────────────────
  The studio is running:  ${URL}

  Sign up there (any address; no email is sent, the account works at once).
  Credit for an account:  npm run studio:local -- grant <email> 5      (in another terminal)
  Payments:               ${billing ? "Stripe test mode. Card 4242 4242 4242 4242, any future date, any CVC." : "off"}
  Videos:                 REAL. A draft costs about a cent; a video about $0.30, from your
                          provider keys, never more than the amount you approve on its button.
  Emails it would send:   http://127.0.0.1:54324

  Ctrl+C stops everything.
────────────────────────────────────────────────────────────────────────
`);
  if (!argv.includes("--no-open") && process.platform === "darwin") void execa("open", [URL], { reject: false });
  await new Promise(() => {});
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  void stop(1);
});
