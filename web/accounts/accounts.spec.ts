import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, type Page, test } from "@playwright/test";
import { data } from "../playwright.accounts.config";

const DRAFT_ID = "20261006-120100-e2e002";
const service = createClient(process.env.ACCOUNTS_SUPABASE_URL!, process.env.ACCOUNTS_SERVICE_KEY!, { auth: { persistSession: false } });
const stamp = Date.now().toString(36);
const A = { email: `ann-${stamp}@example.test`, password: "ann-password-1" };
const B = { email: `bob-${stamp}@example.test`, password: "bob-password-1" };

const userId = async (email: string) => (await service.from("users").select("id").eq("email", email).single()).data!.id as string;
const balance = async (email: string) => Number((await service.from("users").select("balance_usd").eq("email", email).single()).data!.balance_usd);

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("account-link")).toContainText(who.email);
}

async function signUp(page: Page, who: { email: string; password: string }) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("account-link")).toContainText(who.email);
}

test("a stranger signs up, gets nothing to spend, is granted credit, makes a video; another user sees none of it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // Without a session the bare address shows the landing page, at that address — in its own light look, with
  // its own typefaces, and nothing of the studio's header.
  await page.goto("/");
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expect(page.getByTestId("landing")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Type a topic. Get a finished short video.");
  await expect(page.getByTestId("stage").first()).toBeVisible();
  // The Stage shows a still of a real video at once, then the real renderer playing it; the controls under it
  // change what it shows, there and then.
  const player = page.getByTestId("showcase-player");
  await expect(player.locator("img")).toHaveAttribute("src", "/showcase/clockmaker/poster.jpg");
  await expect(player).toHaveAttribute("data-live", "true", { timeout: 20_000 });
  await expect(player.locator("video, img").first()).toBeVisible();
  const before = { font: await player.getAttribute("data-caption-font"), cuts: await player.getAttribute("data-cuts") };
  await page.getByText("Playful", { exact: true }).click();
  await expect(player).toHaveAttribute("data-caption-font", "Luckiest Guy");
  await page.getByText("Glitch", { exact: true }).click();
  await expect(player).toHaveAttribute("data-cuts", /^(glitch|cut)(,(glitch|cut))*$/);
  expect(await player.getAttribute("data-cuts")).not.toBe(before.cuts);
  await page.getByTestId("hook-text").fill("Made in your browser");
  await expect(player).toHaveAttribute("data-hook", "Made in your browser");
  // the words typed are in the film itself (the composition is ordinary page content, not a recording): the
  // title shows for the first three seconds of each pass of the loop, a line of words at a time
  await expect(player.getByText(/browser/i).first()).toBeAttached({ timeout: 30_000 });
  await page.getByText("Sound effects", { exact: true }).click();
  await expect(player).toHaveAttribute("data-sounds", "0");
  await page.getByTestId("restyle-reset").click();
  await expect(player).toHaveAttribute("data-caption-font", before.font!);
  await expect(player).toHaveAttribute("data-cuts", before.cuts!);
  // another of the videos, with a brand that can be taken off
  await page.locator('label[title="Three Mistakes That Make Your Product Photos Look Cheap"]').click();
  await expect(page.getByRole("radio", { name: "Three Mistakes That Make Your Product Photos Look Cheap" })).toBeChecked();
  await expect(player).toHaveAttribute("data-slug", "product-photos");
  await expect(player).toHaveAttribute("data-brand", "true");
  await page.getByText("Brand", { exact: true }).click();
  await expect(player).toHaveAttribute("data-brand", "false");
  // How it was made: five steps, with what the run really produced and cost at each. The steps' costs are the
  // receipt's lines, and the receipt adds up to its total.
  const steps = page.getByTestId("making").locator("> li");
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(0)).toContainText("A clockmaker's apprentice repairs the town clock before the midnight bell");
  await expect(steps.nth(1)).toContainText("$0.0055");
  await expect(steps.nth(3).locator("img")).toHaveCount(4);
  const receipts = page.getByTestId("receipt");
  await expect(receipts).toHaveCount(3);
  for (const receipt of await receipts.all()) {
    const amounts = (await receipt.locator("dd").allInnerTexts()).filter((t) => t.startsWith("$")).map((t) => Math.round(Number(t.slice(1)) * 10_000));
    const total = Math.round(Number((await receipt.getByTestId("receipt-total").innerText()).slice(1)) * 10_000);
    expect(amounts.length).toBeGreaterThanOrEqual(3);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(total);
  }
  await expect(page.getByTestId("shelf-compare")).toContainText("32 cents, with 3 moving scenes");
  await expect(page.getByTestId("shelf-compare")).toContainText("81 cents, with 2 moving scenes");
  // a feature is shown on a real video, not described: the brand comes off it, the sounds come out of it
  const feature = page.getByTestId("feature-player");
  await feature.scrollIntoViewIfNeeded();
  await expect(feature).toHaveAttribute("data-live", "true", { timeout: 20_000 });
  await expect(feature).toHaveAttribute("data-brand", "true");
  await page.getByTestId("feature-brand").click();
  await expect(feature).toHaveAttribute("data-brand", "false");
  await expect(page.getByTestId("feature-cues")).toContainText("an impact at 0:00.0");
  await page.getByTestId("feature-sfx").click();
  await expect(feature).toHaveAttribute("data-sounds", "0");
  // a video on the shelf is played in the Stage at the top
  await page.getByTestId("shelf-play-robot-painter").click();
  await expect(player).toHaveAttribute("data-slug", "robot-painter");
  // the videos' own files are for anyone; nothing else of the server is
  expect((await page.request.get("/showcase/clockmaker/props.json")).status()).toBe(200);
  const site = await page.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, heading: getComputedStyle(document.querySelector("h1")!).fontFamily, text: getComputedStyle(document.body).fontFamily }));
  expect(site.background).toBe("rgb(244, 239, 230)");
  expect(site.heading).toMatch(/fraunces/i);
  expect(site.text).toMatch(/schibsted/i);
  // the typefaces are the page's own files, and they arrived
  expect(await page.evaluate(() => document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === "loaded").length))).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Flow-Chain Studio")).toHaveCount(0);
  // the way in: the account form, and from there the first video
  await expect(page.locator('[data-cta="hero-signup"]')).toHaveAttribute("href", "/signup?next=%2Fnew");
  await page.locator('[data-cta="hero-signup"]').click();
  await expect(page).toHaveURL(/\/signup\?next=%2Fnew$/);
  // house lights down: the studio's side is dark, and has nothing of the landing page's look
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(11, 13, 18)");
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).not.toMatch(/schibsted|fraunces/i);
  // nothing of the studio itself without signing in
  await page.goto("/runs/20261006-120000-e2e001");
  await expect(page).toHaveURL(/\/login\?next=%2Fruns%2F20261006-120000-e2e001$/);
  expect((await page.request.get("/api/runs")).status()).toBe(401);

  await signUp(page, A);
  // with a session the same bare address is the studio
  await page.goto("/");
  await expect(page.getByTestId("landing")).toHaveCount(0);
  await expect(page.getByText("No videos yet.")).toBeVisible();
  await expect(page.getByTestId("header-balance")).toHaveText("$0.00");

  // with no credit not even a draft can be started, and the page says why
  await page.goto("/new");
  await page.getByTestId("topic").fill("foxes at night");
  await expect(page.getByTestId("create-draft")).toBeDisabled();
  await expect(page.getByTestId("credit-note")).toContainText("you have $0.00");

  // the owner of the studio grants credit (npm run studio:grant does exactly this)
  expect((await service.rpc("grant_credit", { p_email: A.email, p_amount_usd: 1, p_note: "welcome" })).error).toBeNull();
  // what the stand-in CLI finds in this user's own runs folder
  const mine = join(data, "runs", await userId(A.email));
  mkdirSync(mine, { recursive: true });
  copyFileSync(join(data, "fixtures/runs", DRAFT_ID, "manifest.json"), join(mine, "_draft-manifest.json"));
  writeFileSync(join(mine, "_plan.json"), JSON.stringify({ items: [{ stage: "clips", scene: 1, costUsd: 0.31 }], totalUsd: 0.31 }));
  writeFileSync(join(mine, "_behave.json"), JSON.stringify({ spendUsd: 0.2 }));

  await page.reload();
  await page.getByTestId("topic").fill("foxes at night");
  // (a page loaded in the worker's first moments may still read "offline"; the form asks again by itself)
  await expect(page.getByTestId("create-draft")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("create-draft").click();
  await expect(page).toHaveURL(/\/runs\/\d{8}-\d{6}-[0-9a-f]{6}$/, { timeout: 30_000 });
  const runUrl = page.url();
  const runId = runUrl.split("/").at(-1)!;
  await expect(page.locator("[data-state=draft]")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("player")).toBeVisible();

  // the approved amount is held, the stand-in CLI "spends" $0.20 of it, the rest comes back
  const generate = page.getByTestId("generate");
  await expect(generate).toHaveText("Generate video — up to $0.31", { timeout: 30_000 });
  await generate.click();
  await expect.poll(() => balance(A.email), { timeout: 30_000 }).toBe(0.7945);
  const calls = readFileSync(join(mine, "_calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  expect(calls).toContainEqual(["resume", runId, "--budget", "0.31", "--cap", "0.31"]);

  await page.goto("/account");
  await expect(page.getByTestId("balance")).toHaveText("$0.79");
  await expect(page.getByTestId("ledger").locator("tr")).toHaveCount(5); // grant; draft held, settled; generation held, settled
  await page.goto("/");
  await expect(page.getByTestId("runs").locator("li")).toHaveCount(1);

  // someone else: an empty studio, and A's run does not exist for them — as a page, through the API, or as a file
  await page.getByTestId("account-link").click();
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/login$/);
  await signUp(page, B);
  await expect(page.getByText("No videos yet.")).toBeVisible();
  expect((await page.goto(runUrl))!.status()).toBe(404);
  for (const path of [`/api/runs/${runId}`, `/api/runs/${runId}/files/manifest.json`, `/api/runs/${runId}/events`]) {
    expect((await page.request.get(path)).status(), path).toBe(404);
  }
  expect((await page.request.post(`/api/runs/${runId}/generate`, { data: { approvedUsd: 0.31 }, headers: { "sec-fetch-site": "same-origin" } })).status()).toBe(404);
  expect(existsSync(join(data, "runs", await userId(B.email), runId))).toBe(false);
  expect(await balance(A.email)).toBe(0.7945);

  // and A, signing in again with the password, has everything back
  await page.goto("/account");
  await page.getByTestId("sign-out").click();
  await page.goto(`/login?next=${encodeURIComponent(`/runs/${runId}`)}`);
  await page.getByLabel("Email").fill(A.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("wrong email or password")).toBeVisible();
  await page.getByLabel("Password").fill(A.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(runUrl);
  await expect(page.getByTestId("player")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a user buys a top-up and a plan at Stripe and has the credit when they come back; the other user sees none of it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // anyone may read what is on sale; buying asks for an account
  await page.goto("/pricing");
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByTestId("offer-starter")).toContainText("$19.00 / month");
  await expect(page.getByTestId("offer-topup-10")).toContainText("$6.00 of credit. It does not expire.");
  await expect(page.getByRole("link", { name: "Sign up to buy" })).toHaveCount(2);
  expect((await page.request.post("/api/billing/checkout", { data: { priceId: "price_x" }, headers: { "sec-fetch-site": "same-origin" } })).status()).toBe(401);

  // B has nothing; the note under a button they cannot use says where credit comes from
  await signIn(page, B);
  await expect(page.getByTestId("header-balance")).toHaveText("$0.00");
  await page.goto("/new");
  await page.getByTestId("topic").fill("owls at dusk");
  await page.getByTestId("credit-note").getByTestId("add-credit").click();
  await expect(page).toHaveURL(/\/pricing$/);

  // a top-up: to Stripe's page (the stand-in pays at once) and back, with the credit already there
  await page.getByTestId("buy-topup-10").click();
  await expect(page).toHaveURL(/\/account\?paid=\d{13}$/, { timeout: 30_000 });
  // the browser is back before Stripe has told the studio: the page says so, and brings the credit in when it comes
  await expect(page.getByTestId("paid-note")).toHaveAttribute("data-state", "waiting");
  await expect(page.getByTestId("balance")).toHaveText("$0.00");
  await expect(page.getByTestId("paid-note")).toHaveAttribute("data-state", "confirmed", { timeout: 20_000 });
  await expect(page.getByTestId("balance")).toHaveText("$6.00");
  await expect(page.getByTestId("payments").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("payments")).toContainText("Top-up");
  await expect(page.getByTestId("payments")).toContainText("$10.00");
  await expect(page.getByTestId("plan")).toHaveText("No plan.");
  await expect(page.getByTestId("ledger")).toContainText("Top-up bought");
  expect(await balance(B.email)).toBe(6);

  // a plan: a month's credit beside the top-up's, told apart
  await page.goto("/pricing");
  await page.getByTestId("buy-starter").click();
  await expect(page).toHaveURL(/\/account\?paid=\d{13}$/, { timeout: 30_000 });
  // a payment made a moment ago (the top-up) is not this one: the page waits for the plan's
  await expect(page.getByTestId("paid-note")).toHaveAttribute("data-state", "waiting");
  await expect(page.getByTestId("paid-note")).toHaveAttribute("data-state", "confirmed", { timeout: 20_000 });
  await expect(page.getByTestId("balance")).toHaveText("$18.00");
  await expect(page.getByTestId("balance-split")).toContainText("$12.00 from your plan, to use by ");
  await expect(page.getByTestId("balance-split")).toContainText("$6.00 that does not expire");
  await expect(page.getByTestId("plan")).toContainText("starter · Active · renews on ");
  await expect(page.getByTestId("payments").locator("tbody tr")).toHaveCount(2);
  // one plan at a time: the pricing page now offers to manage it, not to buy another
  await page.goto("/pricing");
  await expect(page.getByTestId("your-plan")).toBeVisible();
  await expect(page.getByTestId("buy-starter")).toHaveCount(0);
  await expect(page.getByTestId("buy-topup-10")).toBeVisible();
  await page.getByTestId("manage-billing").click();
  await expect(page.getByRole("heading", { name: "Stand-in customer portal" })).toBeVisible();

  // an old address with the note's mark, or a made-up one, shows no note
  await page.goto("/account?paid=1");
  await expect(page.getByTestId("balance")).toHaveText("$18.00");
  await expect(page.getByTestId("paid-note")).toHaveCount(0);

  // A bought nothing and sees nothing of it
  await page.goto("/account");
  await page.getByTestId("sign-out").click();
  await signIn(page, A);
  await page.goto("/account");
  await expect(page.getByTestId("balance")).toHaveText("$0.79");
  await expect(page.getByTestId("payments")).toHaveCount(0);
  await expect(page.getByTestId("plan")).toHaveCount(0);
  await expect(page.getByTestId("ledger")).not.toContainText("Top-up bought");
  expect(errors).toEqual([]);
});
