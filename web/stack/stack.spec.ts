import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { request } from "node:http";
import { HOST, PASSWORD, PORT, runs, USER } from "./stack";

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
  for (const path of ["/", "/api/health"]) expect((await get(path, { login: LOGIN, host: "other.example" })).status, path).toBe(403);
});

test("behind the login the studio works through the queue: a job waits its turn, runs in the worker and the page follows it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // the web container holds no keys: it learns from the worker which are set, and that the worker is there
  const health = JSON.parse((await get("/api/health", { login: LOGIN })).body);
  expect(health.queue).toEqual({ mode: "queue", redis: true, worker: true });
  expect(health.missing).toEqual({ always: [], fal: [], runpod: expect.any(Array) });

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
