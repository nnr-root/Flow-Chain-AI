import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
