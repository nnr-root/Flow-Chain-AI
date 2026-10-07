import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PORT, runs } from "./stack";

const DONE_ID = "20261006-120000-e2e001";
const DRAFT_ID = "20261006-120100-e2e002";
/** Every call the stand-in CLI received inside the worker container (the runs folder is shared with this machine). */
const calls = (): string[][] => {
  const file = join(runs, "_calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
};

test("nothing answers without the login: pages, the API and media", async () => {
  // plain fetch: nothing here may borrow the login the browser tests are configured with
  const base = `http://localhost:${PORT}`;
  for (const path of ["/", "/api/health", `/api/runs/${DONE_ID}`, `/api/runs/${DONE_ID}/files/final.mp4`]) {
    expect((await fetch(base + path)).status, path).toBe(401);
  }
  const wrong = await fetch(`${base}/`, { headers: { authorization: `Basic ${Buffer.from("studio:nope").toString("base64")}` } });
  expect(wrong.status).toBe(401);
});

test("behind the login the studio works through the queue: a job waits its turn, runs in the worker and the page follows it", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // the web container holds no keys: it learns from the worker which are set, and that the worker is there
  const health = await (await request.get("/api/health")).json();
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
