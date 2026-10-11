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
  await expect(page.getByTestId("generate")).toHaveText("Generate video, up to $0.31");

  // The stub CLI cannot price a pin itself, so the test stands in for "the plan is cheaper once scene 1 is a still":
  // it makes the stub answer every later `plan` with $0.12. This proves the page asks the server again after a pin,
  // shows the server's new price and sends that amount as the cap. It does not prove that the CLI persists the pin
  // (the stub's `draft-modes` only records the call) or that the CLI prices a pin correctly.
  writeFileSync(join(runs, "_plan.json"), JSON.stringify({ items: [], totalUsd: 0.12 }));
  await page.getByTestId("scene-1").getByRole("radio", { name: "Still" }).click();
  await expect.poll(calls).toContainEqual(["draft-modes", DRAFT_ID, "--modes", "2,auto,auto", "--json"]);

  // the button now shows the new price, and generating passes exactly that amount to the CLI, as the budget it need
  // not ask about and as the cap on what the job spends in total, without --yes
  const generate = page.getByTestId("generate");
  await expect(generate).toHaveText("Generate video, up to $0.12");
  const started = page.waitForResponse((r) => r.url().endsWith(`/api/runs/${DRAFT_ID}/generate`));
  await generate.click();
  expect((await started).status()).toBe(202);
  await expect.poll(calls).toContainEqual(["resume", DRAFT_ID, "--budget", "0.12", "--cap", "0.12"]);
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

test("a new video is asked for by its length, how long each scene stays and what it is made of; there is no number of scenes to give", async ({ page }) => {
  await page.goto("/new");
  // from five seconds to ten minutes, and nothing longer
  const lengths = page.getByTestId("length").locator("option");
  await expect(lengths).toHaveCount(16);
  await expect(lengths.first()).toHaveText("5 seconds");
  await expect(lengths.last()).toHaveText("10 minutes");
  await expect(page.getByTestId("length")).toHaveValue("30");
  await expect(page.getByLabel("Scenes", { exact: true })).toHaveCount(0);
  // A scene stays one length, or a range the script chooses within: which of the two is said outright, and the
  // lengths are the ones a clip can be. The page says how many scenes that makes.
  const kind = page.getByRole("radiogroup", { name: "Scenes of one length, or of a range" });
  await expect(kind.getByRole("radio", { name: "A range" })).toBeChecked();
  await expect(page.getByTestId("scene-length").getByRole("button", { pressed: true })).toHaveText(["3 s", "4 s", "5 s"]);
  await expect(page.getByTestId("scene-count")).toHaveText("Scenes of 3 to 5 seconds, as the script sees fit: 6 to 10 scenes in all.");
  // a press moves the end it is nearer to
  await page.getByTestId("scene-sec-2").click();
  await expect(page.getByTestId("scene-length").getByRole("button", { pressed: true })).toHaveText(["2 s", "3 s", "4 s", "5 s"]);
  await page.getByTestId("scene-sec-4").click();
  await expect(page.getByTestId("scene-length").getByRole("button", { pressed: true })).toHaveText(["2 s", "3 s", "4 s"]);
  // one length for every scene: one is lit, and a press chooses it
  await kind.getByRole("radio", { name: "The same length" }).click();
  await expect(page.getByTestId("scene-length").getByRole("button", { pressed: true })).toHaveText(["4 s"]);
  await page.getByTestId("scene-sec-5").click();
  await expect(page.getByTestId("scene-count")).toHaveText("Every scene about 5 seconds: 6 scenes in all.");
  await page.getByTestId("length").selectOption("600");
  await expect(page.getByTestId("scene-count")).toContainText("120 scenes in all.");
  // a long script is several answers, and the button says what it may cost
  await expect(page.getByTestId("create-draft")).toHaveText(/Write the script, up to \$0\.[1-9]/);
  await page.getByTestId("length").selectOption("60");
  // back to a range: it opens downwards from the length that was chosen
  await kind.getByRole("radio", { name: "A range" }).click();
  await expect(page.getByTestId("scene-length").getByRole("button", { pressed: true })).toHaveText(["3 s", "4 s", "5 s"]);

  // The styles stand side by side, and the one that is chosen is described underneath.
  await expect(page.getByRole("heading", { name: "Style" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Style" }).getByRole("radio")).toHaveCount(15);
  await expect(page.getByTestId("style-note")).toContainText("Choose for me.");
  await page.getByTestId("look-film_noir").click();
  await expect(page.getByTestId("style-note")).toContainText("Film noir. Suits true crime, detectives");

  // The language the video is told in, one of twenty by its own name, and the voice: every voice has a sample
  // in the language that is chosen.
  await expect(page.getByTestId("language").locator("option")).toHaveCount(20);
  await expect(page.getByTestId("language").locator("option")).toContainText(["English", "Türkçe", "Español", "Deutsch", "Русский", "Tiếng Việt"]);
  await expect(page.getByTestId("language")).toHaveValue("en");
  await expect(page.getByRole("radiogroup", { name: "Voice" }).getByRole("radio")).toHaveCount(2);
  await page.getByTestId("language").selectOption("es");
  const sample = page.waitForRequest((r) => r.url().endsWith("/voices/narrator-f.es.mp3"));
  await page.getByTestId("listen-narrator-f").click();
  await sample;
  await expect(page.getByTestId("listen-narrator-f")).toHaveAccessibleName("Stop the sample of Narrator (female)");
  // a sample is of one language: choosing another ends it
  await page.getByTestId("language").selectOption("tr");
  await expect(page.getByTestId("listen-narrator-f")).toHaveAccessibleName("Hear Narrator (female) in Türkçe");
  await page.getByTestId("voice-narrator-f").click();
  // every sample the form can ask for is there
  for (const code of await page.getByTestId("language").locator("option").evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))) {
    for (const voice of ["narrator-m", "narrator-f"]) expect((await page.request.get(`/voices/${voice}.${code}.mp3`)).status(), `${voice}.${code}`).toBe(200);
  }

  // pictures only, both, or clips only
  const madeOf = page.getByRole("radiogroup", { name: "What the video is made of" });
  await expect(madeOf.getByRole("radio")).toHaveText(["Pictures only", "Pictures and clips", "Clips only"]);
  await expect(madeOf.getByRole("radio", { name: "Pictures and clips" })).toBeChecked();
  await madeOf.getByRole("radio", { name: "Pictures only" }).click();
  await expect(page.getByTestId("made-of-note")).toContainText("Every scene is a generated picture");
  // (and with no clip in it, there is no clip size to choose)
  await expect(page.getByRole("radiogroup", { name: "Clip quality" })).toHaveCount(0);
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });

  await page.getByTestId("topic").fill("A lighthouse keeper's daughter takes over the light");
  const before = calls().length;
  await page.getByTestId("create-draft").click();
  await expect.poll(() => calls().slice(before).find((c) => c[0] === "run")).toBeTruthy();
  const sent = calls().slice(before).find((c) => c[0] === "run")!;
  expect(sent).toEqual(expect.arrayContaining(["--duration", "60", "--scene-seconds", "3-5", "--pin-modes", "2", "--style", "film_noir", "--language", "tr", "--voice", "narrator-f"]));
  expect(sent).not.toContain("--scenes");
});

test("a studio without accounts has no landing page: the bare address is the studio, as ever", async ({ page }) => {
  expect((await page.goto("/welcome"))!.status()).toBe(404);
  await page.goto("/");
  await expect(page.getByTestId("landing")).toHaveCount(0);
  await expect(page.getByTestId("runs")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(0, 0, 0)");
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
