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

  // nothing of the studio without signing in
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/runs/20261006-120000-e2e001");
  await expect(page).toHaveURL(/\/login\?next=%2Fruns%2F20261006-120000-e2e001$/);
  expect((await page.request.get("/api/runs")).status()).toBe(401);

  await signUp(page, A);
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
  await expect(page).toHaveURL(/\/account\?paid=1$/, { timeout: 30_000 });
  await expect(page.getByTestId("paid-note")).toHaveAttribute("data-state", "confirmed");
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
  await expect(page).toHaveURL(/\/account\?paid=1$/, { timeout: 30_000 });
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
