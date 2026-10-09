import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { migrate, migrationFiles, type Psql, setRolePasswords } from "@src/deploy/db-apply";
import { psqlArgs } from "@src/deploy/server";
import { compose, composeEnv, DB_PASSWORDS, HOST, PASSWORD, PORT, repo, runs, USER } from "./stack";

const DONE_ID = "20261006-120000-e2e001";
const DRAFT_ID = "20261006-120100-e2e002";
/** Every call the stand-in CLI received inside the worker container (the runs folder is shared with this machine). */
const calls = (): string[][] => {
  const file = join(runs, "_calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
};

/** A request to the proxy as a client on the internet would send it: any Host name, with or without the login. */
function get(path: string, opts: { host?: string; login?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const headers: Record<string, string> = { host: `${opts.host ?? HOST}:${PORT}` };
    if (opts.login) headers.authorization = `Basic ${Buffer.from(opts.login).toString("base64")}`;
    request({ host: "127.0.0.1", port: PORT, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    })
      .on("error", fail)
      .end();
  });
}
const LOGIN = `${USER}:${PASSWORD}`;

test("nothing answers without the login, and with it only the studio's own name is answered", async () => {
  for (const path of ["/", "/api/health", `/api/runs/${DONE_ID}`, `/api/runs/${DONE_ID}/files/final.mp4`, `/api/runs/${DONE_ID}/events`]) {
    expect((await get(path)).status, path).toBe(401);
  }
  expect((await get("/", { login: `${USER}:nope` })).status).toBe(401);
  // behind the login the app's own guard still stands: the configured public name, and no other
  expect((await get("/api/health", { login: LOGIN })).status).toBe(200);
  for (const path of ["/", "/api/health", "/api/music"]) expect((await get(path, { login: LOGIN, host: "other.example" })).status, path).toBe(403);
});

test("behind the login the studio works through the queue: a job waits its turn, runs in the worker and the page follows it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // the web container holds no keys: it learns from the worker which are set, and that the worker is there
  const health = JSON.parse((await get("/api/health", { login: LOGIN })).body);
  expect(health.queue).toEqual({ mode: "queue", redis: true, worker: true });
  expect(health.missing).toEqual([]);

  // a finished run plays through the proxy (ranged media requests, the live feed)
  await page.goto(`/runs/${DONE_ID}`);
  const player = page.getByTestId("player");
  await expect(player).toHaveAttribute("data-total-frames", "135");
  await player.getByRole("button", { name: /play/i }).click();
  await expect(player.getByText(/^\d+:\d\d \/ \d+:\d\d$/)).not.toHaveText("0:00 / 0:04", { timeout: 20_000 });
  await expect(page.getByTestId("queue-banner")).toHaveCount(0);

  // the one worker slot is taken by a re-render that lasts a few seconds…
  writeFileSync(join(runs, "_behave.json"), JSON.stringify({ sleepMs: 6000 }));
  await page.getByTestId("caption-style").selectOption("mrbeast");
  await page.getByTestId("apply-look").click();
  await expect.poll(calls, { timeout: 30_000 }).toContainEqual(["rerender", DONE_ID, "--caption-style", "mrbeast"]);

  // …so a generation started now waits in line, then runs, and the page shows each step without a reload
  await page.goto(`/runs/${DRAFT_ID}`);
  const generate = page.getByTestId("generate");
  await expect(generate).toHaveText("Generate video — up to $0.31", { timeout: 30_000 }); // priced by the worker, through the quick queue
  await generate.click();
  await expect(page.locator("[data-state=queued]")).toBeVisible();
  await expect(page.getByTestId("working")).toContainText("Waiting in line: next");
  await expect(page.getByTestId("working")).toContainText("Working: generate", { timeout: 30_000 });
  await expect(page.locator("[data-state=draft]")).toBeVisible({ timeout: 30_000 }); // the stand-in CLI changes nothing
  expect(calls()).toContainEqual(["resume", DRAFT_ID, "--budget", "0.31", "--cap", "0.31"]);
  expect(calls().flat()).not.toContain("--yes");
  expect(errors).toEqual([]);
});

test("the stack's own database: made through the door setup uses, reached only from inside, each role held to its part", async () => {
  /** `docker compose` for this stack with the database's profile on; what it printed, or an error that carries what it said. */
  const dc = (args: string[], input = ""): string => {
    try {
      return execFileSync("docker", [...compose, "--profile", "accounts", ...args], { cwd: repo, env: composeEnv(), input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      throw new Error(String((err as { stderr?: string }).stderr || err));
    }
  };
  // started alone, as server:setup starts it before anything that uses it
  dc(["up", "-d", "--wait", "--wait-timeout", "300", "db"]);
  const psql: Psql = async (sql, opts) => dc(psqlArgs(opts), sql);
  const files = migrationFiles(join(repo, "db/migrations"));
  expect(await migrate(psql, files)).toEqual(files.map((f) => f.name));
  await setRolePasswords(psql, DB_PASSWORDS);
  // a second deploy finds nothing to do
  expect(await migrate(psql, files)).toEqual([]);

  /**
   * One statement as a service's role with its password, over the stack's private network: by the name the
   * web app and the worker use. (Inside the container itself the image trusts its own loopback; nothing but
   * the database runs there.)
   */
  const as = (role: string, password: string, sql: string) =>
    dc(["exec", "-T", "-e", `PGPASSWORD=${password}`, "db", "psql", "-h", "db", "-U", role, "-d", "flowchain", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
  expect(as("studio_web", DB_PASSWORDS.web, "select count(*) from public.users")).toBe("0");
  expect(as("studio_web", DB_PASSWORDS.web, "select public.welcome_offer()")).toBe("0");
  expect(() => as("studio_web", DB_PASSWORDS.web, "select public.grant_credit('a@example.test', 1, '')")).toThrow(/permission denied/);
  expect(() => as("studio_web", DB_PASSWORDS.web, "select * from auth.users")).toThrow(/permission denied/);
  // the worker's role runs it (and is told there is no such account), and writes no table itself
  expect(() => as("studio_worker", DB_PASSWORDS.worker, "select public.grant_credit('a@example.test', 1, '')")).toThrow(/not_found/);
  expect(() => as("studio_worker", DB_PASSWORDS.worker, "update public.settings set welcome_credit_usd = 5")).toThrow(/permission denied/);
  // a role's password is its own
  expect(() => as("studio_web", DB_PASSWORDS.worker, "select 1")).toThrow(/password authentication failed/);
  expect(() => as("studio_worker", "", "select 1")).toThrow(/password|no password/i);

  // It has no door to the outside: no port of it is published on this machine …
  const container = dc(["ps", "-q", "db"]).trim();
  expect(JSON.parse(execFileSync("docker", ["inspect", "-f", "{{json .NetworkSettings.Ports}}", container], { encoding: "utf8" }))).toEqual({ "5432/tcp": null });
  // … the web app and the worker reach it by name, and the proxy, which faces the internet, cannot even find it
  const reach = "require('net').connect(5432, 'db').on('connect', () => process.exit(0)).on('error', () => process.exit(1))";
  for (const service of ["web", "worker"]) expect(() => dc(["exec", "-T", service, "node", "-e", reach]), service).not.toThrow();
  expect(() => dc(["exec", "-T", "proxy", "sh", "-c", "nc -z -w 3 db 5432"])).toThrow();
});
