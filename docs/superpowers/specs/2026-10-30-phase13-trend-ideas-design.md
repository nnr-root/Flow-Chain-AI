# Phase 13 — trend ideas: "Suggest a topic" in the new-video form, paid by a fixed credit

Date: 2026-10-30. Status: built; the owner's steps (§8) are not done. Where §10 differs from an earlier section, §10 wins.

## 0. Where this sits

Item 4 of the owner's five-item list (phase 9 spec §0: "trend discovery, paid in credit"), the last one open. Item 3's lip-sync half was
tried and shelved (phase 12 spec §8). Phase 6 said "no trend scraping" (series spec §0); this phase reopens that on purpose, and does
not scrape: it asks a model that searches the web for what is current, and reads a platform's own public chart through its API.

Decisions of the owner (design conversation, 2026-10-30):

- **Experience: both, the form first.** This phase is the new-video form's "Suggest a topic" button. A series that picks its next
  episode from the day's trends is a later phase (§9), not built here.
- **Data: both together.** YouTube's own most-popular chart (raw numbers) and Gemini with Google Search (reads the chart and the web,
  writes ideas for the chosen niche).
- **Limits: the niche rules hold.** Health, religion, politics, money products and disputed news about living people are left out,
  as in every niche (CLAUDE.md "A video may be in a niche"). Real events come with their sources; the script is still written under
  `FACT_RULES`.
- **Price: a fixed credit for each click.**

## 1. The flow

1. The form shows "Suggest a topic" under the topic field, with its price in credits (never dollars; `amount()`/`inCredits()`), for the
   niche, format and language the form already holds. The region is not sent: the CLI takes the language's usual one
   (`src/trends/region.ts`, 31 entries, one per speech language).
2. A click makes a **hidden request** (a row in `runs` in state `'ideas'`, `create_idea_request`), holds the price on it with
   `reserve_credit` (kind `ideas`), and puts one `ideas` command on the worker's **quick queue**. The web waits for the answer
   (`QUICK_WAIT_MS`, 60 s); there is no job to poll.
3. The worker checks the command (`ideasRefusal()`) and that credit is held for exactly that user, request and cap, runs
   `flowchain ideas …` (§2), settles the hold at the price when ideas came and at 0 when none did, and returns the CLI's JSON. The
   studio shows up to 8 ideas.
4. Choosing one **fills the topic field** with its text. Nothing starts by itself; the ordinary paid draft is the user's next click.
5. Without a `YOUTUBE_API_KEY` the chart step is skipped and the model works from search alone. Without the Gemini key, without
   `FLOWCHAIN_TREND_IDEAS=on`, or (with accounts) without a price in `web/content/ideas-price.json`, the button does not exist and the
   route is 404 (modes by environment, nothing else). On a server the worker's health answer carries the switch and the key to the web.

## 2. The pipeline side (`src/trends/`)

Pure parts, tested on their own:

- `chart.ts`: normalizes YouTube's `videos.list?chart=mostPopular` answer (title, channel, category id, view count, region) into
  `ChartItem[]`; keeps at most 25; knows nothing about HTTP.
- `prompt.ts`: builds the ideas prompt from niche, type, language, region and the chart. Every niche's `FACT_RULES`/`FICTION_RULES`,
  its exclusions and the user's own niche text (quoted as theirs, never read as instructions) go in. **Every change to this prompt
  bumps `PROMPT_VERSION`** and adds its changelog line (phase 9 spec §4); `prompt-pins` includes the new prompt.
- `ideas.ts`: the answer's zod schema. `Idea = { topic: string (≤ TOPIC_CHARS), why: string (one sentence), sources: Array<{ title, url }> }`;
  `IdeasAnswer = { ideas: Idea[] }`, accepting 1–12 and keeping the first 8 (Ruling 5). Anything else is a validation problem: one call, no
  retry, a failure that settles the hold at 0 and that the studio shows without a provider's message (§10 Ruling 4).
- `filter.ts`: a deterministic second look after the model: drops an idea whose topic or sources match the left-out categories'
  word lists (reusing the content check's lists where they exist), drops duplicates by normalized topic, and keeps only `https:` source
  links. A dropped idea is not replaced by another paid call: fewer than 6 left is shown as it is, and an empty answer is a failure
  that refunds the charge (§5).

Acting parts:

- `LlmProvider` gains an optional `ideas?(req: IdeasRequest): Promise<{ text, hosts, usage }>` (like `inspect?`, `upsample?`): a provider
  without it has no feature. `GeminiLlm.ideas` makes one `generateContent` call with Google Search grounding on and asks for JSON in
  words (no response schema: it is not assumed to work together with the search tool); the pipeline parses and validates `text`; `test/fakes/providers.ts` gains a fake. Temperature goes in the pinned `TEMPERATURE` table (a new `ideas` entry).
- `src/providers/youtube-chart.ts`: one `fetch` with an API key; no OAuth (the chart is public data). Timeouts and an HTTP error
  become "no chart" and the run goes on with search alone; the key is never printed.
- CLI: `flowchain ideas --language <code> [--region <code>] [--niche <id> | --niche-text …] [--format <id>] [--cap <usd>]` prints
  `{ ideas, dropped }` as JSON. It creates no run folder and no manifest, so no `expectedUsd` is recorded: the credit charge is the
  record (§10 Ruling 7). The measured usage (tokens, searches) goes to stderr on an `ideas:` line.

## 3. The studio side

- No new `JobKind`. `ideasRefusal(args)` in `web/server/jobs/redis.ts` holds the exact shape of an `ideas` command (`--language --cap
  --region --niche --niche-text --format`, nothing else), so the worker checks what it is given as for every other quick command; an
  ideas command sent as a free `cli` job is refused. `JobRunner.ideas(args, hold?)` / `ideasJob` run it; `web/server/jobs/queue.ts` maps
  every worker failure to the fixed `ideas_failed` error (502, "no ideas could be made this time"), a timeout to `worker_offline`.
- Route `POST /api/ideas` through `route()` with its `write` flag (`web/server/ideas.ts` does the work): it makes the hidden request,
  holds the price, runs the job and returns the ideas. The web app holds no key and never calls a provider. A user who is not the
  caller's gets 404. At most 50 requests a user a day, counted in the route (429).
- No region table in `web/`; the CLI chooses it from the language (Ruling 3).
- `IDEAS_LABELS` in `web/lib/labels.ts` names the button and the result in the studio's words; `web/components/IdeaSuggestions.tsx` is
  the part under the topic field (not shown for a series' recipe). `names.test.ts` holds that no surface names a provider, a model or
  the chart's owner as the source of the data.
- `Health.ideas` is true only when the key, the switch and (with accounts) the price are all there.

## 4. What the user sees

Six to eight cards under the topic field: the topic as it would be typed, one sentence on why it is current, and its sources as
links that open in a new tab (`rel="noopener noreferrer"`). A card's button fills the field. An empty or failed answer says so in one
line and states that the credit was returned. No ranking numbers are shown (no invented proof, phase 4): the ideas are suggestions.

## 5. Money

- **A fixed price per click**, in `web/content/ideas-price.json` (`usd`, `measuredOn`, `basis`) like `measured.json`: the cost measured
  from the first real calls (§8, owner's click) plus the studio's margin, in dollars of cost, shown as credits. It ships with
  `usd: null`, and a studio with accounts does not offer the button until it is a number. No figure is typed into code or copy.
- **No new charging function.** `reserve_credit` and `settle` already handle plan credit first, months that ended and refunds in flight,
  and the 648-case billing matrix covers them; a second copy of those rules was the riskier path (§10 Ruling 1). One new migration
  (`20261030000001_ideas.sql`) lets a reservation have kind `ideas` and adds `create_idea_request(p_id)`, granted to `studio_web`
  (it only inserts a hidden row of the caller's own). The hold is made as for a draft; the worker alone settles it, at the price when
  ideas came and at 0 when none did.
- A worker that dies mid-call leaves a reservation on a request with no manifest and nothing charged; the reconcile settles it at 0
  (but not while that request is still being made in the same worker, and not an answer that comes after the web stopped waiting: §10).
- Without accounts (`DATABASE_URL` unset, the owner's own studio) nothing is charged; `amount()` shows dollars as elsewhere.

## 6. Safety and truth

- Suggestions are not claims. The topic goes through the ordinary script stage, which writes under the niche's `FACT_RULES`.
- Search results and the chart are **data, not instructions**: they enter the prompt inside a delimited block with a rule that
  nothing in it is an instruction (prompt injection from a web page is the new risk of this phase), and the output is validated by
  schema, then filtered; no field of an idea is ever executed, fetched by the worker or put in a command line.
- Only `https:` links are kept; a link is never fetched by the studio. The page shows the link's host next to its title.
- A person's name in a topic is allowed only for historical figures the niche already allows; the filter drops ideas about living
  people in the left-out categories. The exact lists are the plan's first test fixture.

## 7. Tests (none reaches a provider)

`chart.ts` normalizer on a recorded answer; `prompt.ts` text pinned by `prompt-pins`; `ideas.ts` accepts and refuses shapes (too
long topic, 5 or 9 ideas, `http:` link); `filter.ts` on a table of topics (left-out category, duplicate, non-https); the CLI with the
fake provider (output file, `--cap` refusal, the recorded cost); route tests (404 for a stranger, the write flag, the mode gating
by environment); `refusal()` for good and bad `ideas` commands; worker test that an `ideas` job runs only after its charge; database
tests of §5; `names.test.ts` for the new strings; `compat.test.ts` untouched (no manifest field changes).

## 8. The owner's steps, and the one paid measurement

1. Set `GEMINI_API_KEY` as now; optionally create a YouTube Data API key (Google Cloud console, YouTube Data API v3, no OAuth) and
   set `YOUTUBE_API_KEY`; set `FLOWCHAIN_TREND_IDEAS=on`.
2. **A measurement, the owner's click** (CLAUDE.md: nothing that spends money runs without it): three real calls of
   `npm run flowchain -- ideas --language en --niche <id>` (and one `--niche-text`) with the real keys, to record the real cost per click
   (tokens and searches, at the provider's current published prices, plus a margin), whether Google Search grounding works on this key
   and model (hosts non-empty), and what the answers look like. Then write the price into `web/content/ideas-price.json`. Until then
   the file has no price and the button is not offered with accounts (the same idea as the switch that guards 60 fps without its prices).
3. On a server, set `FLOWCHAIN_TREND_IDEAS=on` and `GEMINI_API_KEY` for the **worker** (it answers the health check the web reads), and
   deploy; the price file is bundled into web and worker.

## 9. Out of scope, parked on purpose

- **Series choosing their episodes from trends.** A series is its owner's standing approval; letting a trend decide what it makes is
  a separate spec (`topicSource: "premise" | "trend"` on the recipe, which owner approval, which risk rules, the cost in the series'
  credit check). `IdeasAnswer` is shaped so a series can take one idea without a new type.
- A shared daily cache of ideas by (niche, language, region, day): it would lower the cost of a click; it needs a table and a
  migration. Add it only if the measured cost makes it matter.
- Trends in video form (what scenes or sounds are popular), analytics of the user's own channel, thumbnails and titles.
- Other chart sources (other platforms' APIs).
- Pruning old hidden request rows (state `'ideas'`): see §10.

## 10. What was found and changed (a later section wins)

The plan's rulings, as built:

1. **Money reuses `reserve_credit`/`settle`** and a hidden request row instead of the new worker-only function §5 first planned. An
   idea request is a `runs` row in state `'ideas'` (no list shows it, and the count of unstarted videos never sees it), held with kind
   `ideas`, settled at the price on success and at 0 on failure. Cost if wrong: a few rows of hidden state per click.
2. **Synchronous, not polled:** the quick queue, as for `plan` and `look`; `QUICK_WAIT_MS` = 60 s. `ideasRefusal` replaces a `JobKind`.
3. **Region comes from the language in the CLI**; the web sends only the language.
4. **`LlmProvider.ideas` returns `{ text, hosts, usage }`**, not parsed JSON: search with a response schema is not assumed to work, so
   JSON is asked for in words, parsed and validated by the pipeline. One call, no retry; an invalid answer is a failure and settles at 0.
5. **The schema accepts 1–12 ideas and keeps the first 8**; the prompt asks for 8. Fewer than 6 after the filter is shown as it is.
6. **A source is kept only when its host is among the hosts the model really read** (grounding metadata); an idea may have none.
7. **No manifest and no recorded `expectedUsd`:** an ideas call belongs to no run folder; the charge is its record.
8. **Ideas are written in English**; the script stage writes the video in its language.

What the tasks found:

- **The reconcile flipped a hidden request** (task 1 review): `set_run_state` moved an `'ideas'` row to `'creating'`, which counts among
  unstarted videos. It now leaves an `'ideas'` row alone; tests pin it, and that 25 requests do not trip `too_many_runs`.
- **The reconcile must not refund a request still being made** (task 4 review): the worker keeps the ids it is running (`ideasInFlight`)
  and `settleIdle` skips them. And an answer that comes after the web stopped waiting (`WORKER_QUICK_WAIT_MS` in tests, by default the
  web's `QUICK_WAIT_MS`, measured from the job's enqueue time) is thrown away and settled at 0, so a user is never charged while told that
  nothing was made. Each guard was removed once to see its test fail; so was the clause that checks the job's user against the reservation's.
- **The daily cap of 50 hidden requests a user is in the route, not the database** (task 1 review, ruled): it keeps the migration to what
  was planned. Cost if wrong: two simultaneous clicks can both pass the check; `reserve_credit`'s limit on open jobs still bounds them.
- **`ideas_failed` (502)** is a new error code in the error table (`web/server/http.ts`); every worker failure maps to its fixed text, so
  the CLI's stderr (which may carry an SDK message) never reaches a customer.
- **Env keys:** `FLOWCHAIN_TREND_IDEAS` (`on`/`off`, default off) and `YOUTUBE_API_KEY` (optional).
- **The price file ships with `usd: null`**; with accounts the button is not offered until it is set. `Health.ideas` on a server comes
  from the worker's health answer, so the worker (not the web) needs `GEMINI_API_KEY` and `FLOWCHAIN_TREND_IDEAS=on`.
- **Installed `@google/genai` names** matched the brief and needed no casts: `candidates[0].groundingMetadata.groundingChunks[].web.{uri,title}`,
  `webSearchQueries`, `usageMetadata.promptTokenCount` / `candidatesTokenCount`, `config.httpOptions.timeout`.
- Smaller findings: niche `history-mysteries` does not exist (the pin uses `history`); `SPEECH_LANGUAGES` has `no` (not `nb`), `ms` and
  `tl` (the region table has 31 keys and a test pins it to that set); the database client has no `{ count, head }` option, so the cap
  counts the rows it selects; `PROMPT_VERSION` is `2026-10-30.17` with two pins (`ideas`, `ideas:custom`).
- **Tests that could not run on the implementer's machine:** `tenant-queue.test.ts`'s "with the bucket" group (4 tests; MinIO's image
  cannot be pulled there). This phase did not change them; the rest of that file and the new ideas tests ran against the local
  database and Redis.

Parked, in plain words:

- **Hidden request rows are never pruned.** Each click leaves one `'ideas'` row in `runs`; delete old ones when they matter.
- **The left-out word lists over-catch some history topics** (campaign, church, diet, pope, senate, congress, pandemic). Revisit after
  real outputs.
- **Free ideas if `settle` fails after a successful call:** the user keeps the ideas and the hold stays open until the reconcile settles
  it at 0. Accepted.
- **A narrow race** between the reconcile's idle check and the worker taking the job (add the id to `ideasInFlight` before reading the reservation).
- **The CLI's `--language` is not checked against the speech languages**, and its catch prints the SDK's message to stderr (the owner's
  own studio may see it; customers never do).
- **The button:** no busy label or `aria-busy`. The accounts tests still mock the web side's health (its price cannot be known to the
  worker's own answer); the queue-without-accounts test exercises the worker's real answer.
- **The daily cap's test** does not pin the 24-hour window or the state filter, and the cap counts rows it selects, so two simultaneous
  clicks can both pass it (above).
- **Whether Google Search grounding works with this API key and model is unmeasured** until the owner's step in §8.

### The final review's fix wave

- **The queue without accounts works** (`REDIS_URL` set, `DATABASE_URL` not). The worker asked every ideas job for `--cap`, but that
  studio holds no credit and sends none, so the button showed and every click failed. `ideasRefusal` now asks for `--cap` only where
  credit is held (`needsCap`: the worker has a database); a cap that is there is still checked. A test runs a real worker without a
  database: the form's health flag comes from the worker's own health answer through the queue, the ideas come back, the CLI was asked
  without a cap, and nothing is settled.
- **A card shows the link's host** beside the model's title (§6), without `www.`; an address that does not parse or is not `https:`
  gets no link. The card is rendered in a test (`web/test/idea-card.test.ts`).
- **The price is in ten-thousandths.** The database holds credit to four decimals, and the worker runs a request only when the hold
  equals the command's cap; a price like 0.12345 was held as 0.1235 and refused on every click. Such a price is now no price (the button
  is not offered).
- **Charged only for ideas the studio can show.** The worker reads the CLI's answer before settling: one that is not JSON, or has no
  ideas, is a failure and settled at 0 (the web would have told the user their credit was returned). The late-answer margin is five
  seconds short of the web's wait, not one, so an answer still crossing Redis is refunded rather than charged and never shown.
- **The chart cannot close its own data block:** titles and channels lose runs of three angle brackets and format characters (bidi,
  zero-width), and a category id is passed on only as one to four digits. An own niche's text is set on one line. A link given twice in
  one idea is kept once. The pinned prompts did not change, so `PROMPT_VERSION` stays.
- **The account's history names a topic suggestion's rows** ("Held for a topic suggestion", "Topic suggestion settled") and links them
  to no video; whether a row is one is told by its reservation's kind, read with the ledger (`ledgerEntry`, `web/lib/ledger.ts`).
- **Still accepted:** free ideas if `settle` fails after a successful call (the reconcile settles the open hold at 0), and the
  millisecond race between the reconcile's idle check and the worker taking the job. Both cost at most one suggestion's price, never
  a charge for nothing.

## 11. The measurement (2026-10-30, the owner's click; four real calls, no chart key, model `gemini-flash-latest`)

- **Google Search works on the account's key.** One call answered (niche `space-science`): 8 ideas, 0 dropped, all current to the week (October 2026), 4 of 8 with a source whose host the model really read; usage 1,365 tokens in, 1,476 out, **9 searches**; 45 s.
- **Three of the four calls failed at the 45 s limit** (`history`, `animals`: the service answered `DEADLINE_EXCEEDED` after 45 s; the niche text call: the client's own abort at 47 s). A grounded call that runs nine searches takes about 45 s or more. The 45 s `httpOptions.timeout` in `GeminiLlm.ideas`, the 60 s `runShort` limit and the web's 60 s wait (`QUICK_WAIT_MS`) are too tight for it: as built, most clicks would fail and be refunded.
- **The CLI printed the service's raw JSON error to stderr** (known minor from Task 3; customers never see it, the queue maps it to the fixed text).
- **Cost per click is dominated by searches, not tokens**: Google bills a Gemini 3 model per search query (published range US$14–35 per 1,000 queries after a monthly free allowance; looked up 2026-10-30, ai.google.dev/pricing is the source to check), so 9 searches are about US$0.13–0.32 beyond the free allowance, against a few tenths of a cent for the tokens. A whole 4-scene video costs about US$0.25 today. The price file stays `usd: null` until the owner decides how to bring this down (fewer searches asked for in the prompt, which needs a prompt-version bump; longer timeouts) and measures again.
- Not measured: the chart (no `YOUTUBE_API_KEY`), whether a failed (504) call is billed, the free allowance in effect on this key.
- **The follow-up (same day, the owner's approval of the two remedies; prompt version `2026-10-30.18`).** The prompt now asks for **at most 3 web searches** in all, then an answer from what they found. The time is cut from one number, `IDEAS_WAIT_MS` = 110 s (`web/server/jobs/redis.ts`): the web waits that long for ideas (the other quick commands keep `QUICK_WAIT_MS` = 60 s), the worker's late-answer rule uses it (`lateAnswer`: late from five seconds before it), the CLI gets `IDEAS_WAIT_MS` − 10 s = 100 s (`runShort`'s new `timeoutMs`; the local runner passes the same), and the model call 90 s (`IDEAS_MODEL_TIMEOUT_MS`). Nothing else on the path cuts a 100 s request: `web/proxy.ts` and `web/next.config.ts` set no timeout, and Caddy's `reverse_proxy` has none by default. The price stays `usd: null` until the owner measures again with this prompt (how many searches it really runs, and how long it takes).
