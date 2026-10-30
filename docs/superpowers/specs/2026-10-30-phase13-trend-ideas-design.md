# Phase 13 — trend ideas: "Suggest a topic" in the new-video form, paid by a fixed credit

Date: 2026-10-30. Status: design, not built.

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

1. The form shows "Suggest a topic" with its price in credits (never dollars; `amount()`/`inCredits()`), for the niche, language and
   region the form already holds. The region is the user's account region where there is one, else the language's usual one (a small
   table in this phase's code, §3).
2. A click opens a **fixed charge** for the user (§5), then queues an `ideas` job.
3. The worker runs `flowchain ideas …` (§2), which writes `ideas.json` and prints it; the studio shows 6–8 ideas.
4. Choosing one **fills the topic field** with its text. Nothing starts by itself; the ordinary paid draft is the user's next click.
5. Without a `YOUTUBE_API_KEY` the chart step is skipped and the model works from search alone. Without the Gemini key, or without
   `FLOWCHAIN_TREND_IDEAS=on`, the button does not exist (modes by environment, nothing else; the route is 404).

## 2. The pipeline side (`src/trends/`)

Pure parts, tested on their own:

- `chart.ts`: normalizes YouTube's `videos.list?chart=mostPopular` answer (title, channel, category id, view count, region) into
  `ChartItem[]`; keeps at most 25; knows nothing about HTTP.
- `prompt.ts`: builds the ideas prompt from niche, type, language, region and the chart. Every niche's `FACT_RULES`/`FICTION_RULES`,
  its exclusions and the user's own niche text (quoted as theirs, never read as instructions) go in. **Every change to this prompt
  bumps `PROMPT_VERSION`** and adds its changelog line (phase 9 spec §4); `prompt-pins` includes the new prompt.
- `ideas.ts`: the answer's zod schema. `Idea = { topic: string (≤ TOPIC_CHARS), why: string (one sentence), sources: Array<{ title, url }> }`;
  `IdeasAnswer = { ideas: Idea[] (6–8) }`. Anything else is a validation problem and takes the script stage's repair path (one retry
  with the problems listed, then a clear failure the studio shows without a provider's message).
- `filter.ts`: a deterministic second look after the model: drops an idea whose topic or sources match the left-out categories'
  word lists (reusing the content check's lists where they exist), drops duplicates by normalized topic, and keeps only `https:` source
  links. A dropped idea is not replaced by another paid call: fewer than 6 left is shown as it is, and an empty answer is a failure
  that refunds the charge (§5).

Acting parts:

- `LlmProvider` gains an optional `ideas?(req: IdeasRequest): Promise<unknown>` (like `inspect?`, `upsample?`): a provider without it
  has no feature. `GeminiProvider.ideas` makes one `generateContent` call with Google Search grounding on and a JSON response
  schema; `test/fakes/providers.ts` gains a fake. Temperature goes in the pinned `TEMPERATURE` table (a new `ideas` entry).
- `src/providers/youtube-chart.ts`: one `fetch` with an API key; no OAuth (the chart is public data). Timeouts and an HTTP error
  become "no chart" and the run goes on with search alone; the key is never printed.
- CLI: `flowchain ideas --niche <id> [--niche-text …] --language <code> --region <code> [--type <id>] --out <file>` writes `ideas.json`
  and prints it. It has `--cap <usd>` like `reroll`; the call is recorded the way every paid call is (`expectedUsd` before it can be
  lost). It does not create a run folder: the output file is the job's own, in the user's scope.

## 3. The studio side

- `web/server/jobs/types.ts`: `JobKind` gains `"ideas"`; `KIND_OF` in `web/server/jobs/redis.ts` maps the command `ideas` to it, and
  `refusal()`/`commandKind()` gain the exact shape of an `ideas` command (flags above, nothing else), so the worker checks what it is
  given as it does for every other kind.
- Route `POST /api/ideas` through `route()` with its `write` flag; same-origin and session checks as every route; a user who is not
  the caller's gets 404. The web app holds no key and never calls a provider: it checks the charge, queues the job, returns the job id;
  the result comes back through the same job-polling the form already uses.
- The region table (language → usual region, ~31 entries) lives in `web/lib/`, no secrets, no imports from the pipeline.
- `web/lib/labels.ts` names the button and the result in the studio's words ("Suggest a topic", "Why it is current", "Sources").
  `names.test.ts` holds that no surface names a provider, a model or the chart's owner as the source of the data.

## 4. What the user sees

Six to eight cards under the topic field: the topic as it would be typed, one sentence on why it is current, and its sources as
links that open in a new tab (`rel="noopener noreferrer"`). A card's button fills the field. An empty or failed answer says so in one
line and states that the credit was returned. No ranking numbers are shown (no invented proof, phase 4): the ideas are suggestions.

## 5. Money

- **A fixed price per click**, in `web/content/ideas-price.json` as a dated, sourced entry like `measured.json`: the cost measured from
  the first real calls (§8, owner's click) plus the studio's margin, in dollars of cost, shown as credits. No figure is typed into
  code or copy.
- The existing path reserves credit **for a run** (`reserve_credit` names user, run, kind, cap; the worker runs a paid job only with
  an open reservation for exactly those). An ideas click has no run. So this phase adds **one new migration** (`db/migrations/`, a new
  file: the earlier ones are frozen once applied) with a function that charges a fixed amount for an `ideas` job id: exactly-once by
  job id, takes plan credit first like every settlement, refuses when the credit is not there, returns the charge when the job is
  marked failed or empty. It is granted to `studio_worker` only, never to `studio_web`; the web asks the worker to open it, as it
  does for a draft. `test/db/` gets a case for every ordering it can meet (charge twice, fail after charge, refund twice, short
  credit, plan credit and permanent credit mixes) in the style of the 648-case billing matrix, and `accounts.test.ts`'s grants check
  covers it. **This is the largest part of the phase and its main risk**; the plan's first task reads `reserve_credit`/`settle` and
  settles whether the new function can be a thin variant of them or must stand alone.
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
2. **A measurement, the owner's click** (CLAUDE.md: nothing that spends money runs without it): the plan's first task builds the
   command; the controller then asks, and runs `ideas` for three niches with the real keys, to record the real cost per click,
   whether Google Search grounding works on the account's plan and model, and what the answers look like. Until then
   `ideas-price.json` has no price and the button is not offered (the same switch that guards 60 fps without its prices).

## 9. Out of scope, parked on purpose

- **Series choosing their episodes from trends.** A series is its owner's standing approval; letting a trend decide what it makes is
  a separate spec (`topicSource: "premise" | "trend"` on the recipe, which owner approval, which risk rules, the cost in the series'
  credit check). `IdeasAnswer` is shaped so a series can take one idea without a new type.
- A shared daily cache of ideas by (niche, language, region, day): it would lower the cost of a click; it needs a table and a
  migration. Add it only if the measured cost makes it matter.
- Trends in video form (what scenes or sounds are popular), analytics of the user's own channel, thumbnails and titles.
- Other chart sources (other platforms' APIs).
