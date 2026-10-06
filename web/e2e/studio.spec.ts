import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const DONE_ID = "20261006-120000-e2e001";
const DRAFT_ID = "20261006-120100-e2e002";
const runs = join(import.meta.dirname, "../.e2e/runs");
/** Every call the stub CLI received so far. */
const calls = (): string[][] => {
  const file = join(runs, "_calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
};

/** The Player's own clock ("0:01 / 0:04"), read from its controls. */
const clock = (page: Page) => page.getByTestId("player").getByText(/^\d+:\d\d \/ \d+:\d\d$/);

test("a finished run plays in the Player, a look change previews at once, and Apply starts a free re-render", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto("/");
  const card = page.getByTestId("runs").getByRole("link", { name: /The Fox and the River/ });
  await expect(card.locator("[data-state=done]")).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/runs/${DONE_ID}$`));

  // the real composition is mounted with the run's real media, and it plays
  const player = page.getByTestId("player");
  await expect(player).toHaveAttribute("data-total-frames", "135");
  await expect(player.locator("video").first()).toHaveAttribute("src", /fitted\/scene_01\.mp4/);
  await expect(clock(page)).toHaveText("0:00 / 0:04");
  await player.getByRole("button", { name: /play/i }).click();
  await expect(clock(page)).not.toHaveText("0:00 / 0:04", { timeout: 15_000 });
  await expect(page.getByTestId("draft-note")).toHaveCount(0);

  // a scene block seeks
  await page.getByTestId("seek-3").click();

  // changing the caption style asks for new props with that look, and the Player takes them
  const props = page.waitForResponse((r) => r.url().endsWith(`/api/runs/${DONE_ID}/props`) && r.request().postDataJSON().look.captionStyle === "mrbeast");
  await page.getByTestId("caption-style").selectOption("mrbeast");
  const body = await (await props).json();
  expect(body.draft).toBe(false);
  expect(body.props.captions.style.font.family).toBe("Luckiest Guy");
  await expect.poll(() => page.evaluate(() => [...document.fonts].some((f) => f.family.includes("Luckiest Guy")))).toBe(true);

  // Apply starts `rerender` with exactly that look (the stub CLI records it; nothing is rendered or bought)
  const started = page.waitForResponse((r) => r.url().endsWith(`/api/runs/${DONE_ID}/rerender`));
  await page.getByTestId("apply-look").click();
  expect((await started).status()).toBe(202);
  await expect.poll(calls).toContainEqual(["rerender", DONE_ID, "--caption-style", "mrbeast"]);
  expect(errors).toEqual([]);
});

test("a draft previews with placeholders, shows the new price after a scene is pinned and generates capped at it", async ({ page }) => {
  await page.goto(`/runs/${DRAFT_ID}`);
  await expect(page.locator("[data-state=draft]")).toBeVisible();
  await expect(page.getByTestId("draft-note")).toBeVisible();
  await expect(page.getByTestId("player").locator("img").first()).toHaveAttribute("src", /draft\/scene_0\d\.svg$/);
  await expect(page.getByTestId("generate")).toHaveText("Generate video — up to $0.31");

  // The stub CLI cannot price a pin itself, so the test stands in for "the plan is cheaper once scene 1 is a still":
  // it makes the stub answer every later `plan` with $0.12. This proves the page asks the server again after a pin,
  // shows the server's new price and sends that amount as the cap. It does not prove that the CLI persists the pin
  // (the stub's `draft-modes` only records the call) or that the CLI prices a pin correctly.
  writeFileSync(join(runs, "_plan.json"), JSON.stringify({ items: [], totalUsd: 0.12 }));
  await page.getByTestId("scene-1").getByRole("radio", { name: "Still" }).click();
  await expect.poll(calls).toContainEqual(["draft-modes", DRAFT_ID, "--modes", "2,auto,auto", "--json"]);

  // the button now shows the new price, and generating passes exactly that amount as the CLI's budget, without --yes
  const generate = page.getByTestId("generate");
  await expect(generate).toHaveText("Generate video — up to $0.12");
  const started = page.waitForResponse((r) => r.url().endsWith(`/api/runs/${DRAFT_ID}/generate`));
  await generate.click();
  expect((await started).status()).toBe(202);
  await expect.poll(calls).toContainEqual(["resume", DRAFT_ID, "--budget", "0.12"]);
  expect(calls().flat()).not.toContain("0.31");
  expect(calls().flat()).not.toContain("--yes");
});

test("a reroll first saves the look being previewed, then starts capped at the confirmed price", async ({ page }) => {
  await page.goto(`/runs/${DONE_ID}`);
  await expect(page.locator("[data-state=done]")).toBeVisible();
  await page.getByTestId("caption-style").selectOption("minimalist");
  await page.getByTestId("scene-2").getByRole("button", { name: "New clip" }).click();
  const started = page.waitForResponse((r) => r.url().endsWith(`/api/runs/${DONE_ID}/reroll`));
  await page.getByRole("dialog", { name: "Confirm regeneration" }).getByRole("button", { name: "Confirm" }).click();
  expect((await started).status()).toBe(202);
  const reroll = (c: string[]) => c[0] === "reroll";
  await expect.poll(() => calls().some(reroll)).toBe(true);
  const all = calls();
  const at = all.findIndex(reroll);
  const price = all[at].at(-1)!;
  expect(all[at]).toEqual(["reroll", DONE_ID, "--scene", "2", "--stage", "clips", "--budget", price, "--cap", price]);
  expect(Number(price)).toBeGreaterThan(0);
  expect(all.slice(0, at)).toContainEqual(["look", DONE_ID, "--caption-style", "minimalist"]);
});

test("the server answers its loopback name only: a foreign Host is refused on pages, the API and static files", async ({ request }) => {
  const foreign = { host: "studio.evil.example:3132" };
  // a real static file of this build, to prove the check also stands in front of files Next serves by itself
  const home = await request.get("/");
  expect(home.status()).toBe(200);
  const asset = /\/_next\/static\/[^"']+\.(?:js|css)/.exec(await home.text())?.[0];
  expect(asset).toBeTruthy();

  for (const path of ["/", "/api/health", `/runs/${DONE_ID}`, `/api/runs/${DONE_ID}`, "/api/music", "/api/brand-kits", asset!]) {
    const refused = await request.get(path, { headers: foreign });
    expect(refused.status(), `${path} with a foreign Host`).toBe(403);
    expect(await refused.text()).not.toContain("Fox");
    expect((await request.get(path)).status(), `${path} with the studio's own Host`).toBe(200);
  }
  // an RSC request for a page (what a client-side navigation sends) is refused like the page itself
  expect((await request.get(`/runs/${DONE_ID}`, { headers: { ...foreign, rsc: "1" } })).status()).toBe(403);
});

test("an upload larger than the 10 MB the request interceptor would keep still arrives whole", async ({ request }) => {
  const bytes = Buffer.alloc(15 * 1024 * 1024, 0x55);
  bytes.write("ID3"); // an MP3 by content
  const res = await request.post("/api/music", {
    headers: { "sec-fetch-site": "same-origin" },
    multipart: { name: "e2e big track", file: { name: "big.mp3", mimeType: "audio/mpeg", buffer: bytes } },
  });
  expect(res.status()).toBe(201);
  const { track } = (await res.json()) as { track: { id: string; bytes: number } };
  rmSync(join(import.meta.dirname, "../.e2e/uploads", track.id.replace("upload:", "")), { force: true });
  expect(track.bytes).toBe(bytes.length);
  // the upload endpoints are outside the interceptor, so their own guard must refuse a foreign Host
  const foreign = await request.post("/api/music", {
    headers: { "sec-fetch-site": "same-origin", host: "studio.evil.example:3132" },
    multipart: { file: { name: "x.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("ID3x") } },
  });
  expect(foreign.status()).toBe(403);
});
