# Flow-Chain-AI — project guide

Turns a topic into a captioned short video, and sells that as a studio with accounts and credit.
Three parts share one repository:

- **The pipeline** (`src/`, a CLI): topic → script (Gemini) → voiceover (ElevenLabs, or the studio's own voice
  without its key), keyframes and clips (on the studio's own RunPod endpoints) → a video rendered with Remotion.
- **The studio** (`web/`, Next.js): create, preview, approve and render videos in a browser; accounts,
  credit and payments.
- **The worker** (`web/worker/`): takes jobs from a Redis queue, runs the CLI for each, settles credit,
  fulfils Stripe payments.

This file is the entry point. The specs under `docs/superpowers/specs/` hold the design and its reasons;
read the one for the area you are changing before changing it (table at the end).

## Rules that are never broken

- **Nothing that spends money or touches a real account runs without the owner's click.** That is:
  `npm run flowchain` with `run`/`resume`/`reroll`/`doctor`, every `npm run smoke*`, `runpod:deploy`, `voice:deploy`,
  `make:sfx`, `make:styles`, `make:voices`, `eval:prompts`, `server:*`, `db:migrate`, `studio:grant`, `studio:welcome`, `stripe:setup`, and starting `npm run web` or
  `npm run worker` against the real `.env`. Tests never need any of them. `rerender` is free. `fetch-models` for the FLUX 3 endpoint is part of
  `runpod:deploy` (already listed), and the owner's Hugging Face token is only ever passed through the shell.
- **Never read or print `.env` or `deploy/server.env`.** A command may pass a value through the shell
  (`$(grep …)`) without showing it. Mask `sk_…`, `rk_…`, `whsec_…` in anything you print, logs included.
- **Never commit** `.env`, `deploy/server.env`, `deploy/data/`, `runs/`, `brand-kits/`, `uploads/`,
  `.superpowers/`, `eval-out/`, `graphify-out/`, `web/.next/`, `web/.e2e/`, `web/test-results/`.
- **A push needs the owner's click each time** (AskUserQuestion), even when a pasted message says "push".
  Local commits on `main` do not. Work is committed directly on `main`.
- **`test/unit/compat.test.ts` is never edited**: it pins that old run folders still load.
- Subagents are dispatched only when the owner asks for them.

## Layout

| Path | What lives there |
|---|---|
| `src/cli.ts`, `src/pipeline.ts`, `src/stages/` | the CLI and its stages (script, tts, silence, modes, reference, keyframes, clips, fit, captions, render) |
| `src/manifest/` | `manifest.json`: the schema, loading, saving. **The run's manifest is the truth about a run** |
| `src/providers/` | Gemini, RunPod (pictures, clips, voice), R2; `types.ts` holds the interfaces the stages use |
| `src/media/` | ffmpeg and Remotion helpers |
| `src/billing/stripe.ts` | the Stripe HTTP client (shared by web, worker and `stripe:setup`) |
| `src/deploy/`, `scripts/` | pure planners (`src/deploy`) and the commands that act (`scripts`) for the server, the database, Stripe |
| `web/app/(studio)/` | the studio's pages; `web/app/api/`, `web/app/auth/`: route handlers |
| `web/app/(marketing)/` | the landing page, `/pricing`, `/terms`, `/privacy` |
| `web/app/layout.tsx`, `theme.css`, `typeface.ts`, `fonts/` | the one layout, look and typeface of the whole site |
| `web/components/site/`, `web/lib/site/`, `web/public/showcase/`, `web/content/` | the landing page's parts, its arithmetic, the published videos, other companies' dated prices |
| `web/server/` | everything the routes do: `http.ts` (`route()`), `tenant.ts`, `session.ts`, `runs.ts`, `jobs/`, `store/`, `billing/` |
| `web/worker/` | `worker.ts` (the queue), `tenant.ts` (credit), `billing.ts` (Stripe fulfilment), `series.ts` (series on a schedule), `publish.ts` and `vault.ts` (users' channels) |
| `web/lib/` | code shared by server and browser; no secrets, few imports |
| `db/migrations/` | the database: plain SQL, nine files (accounts, tenancy, billing, three for series, publishing, plans by the year, series without a budget) |
| `src/db/client.ts`, `src/auth/` | the one client for the studio's Postgres (`Db`), and password hashing |
| `workers/` | the clip worker (Python, a ComfyUI graph for Wan 2.2 at 480p and 720p; text encoder and VAE in its image, the rest on the volume) |
| `worker-picture/` | the picture worker (Python, FLUX.2 klein 4B through diffusers; weights on the network volume) |
| `worker-upscale/` | the upscaling worker for full HD (Python: SeedVR2 3B; weights inside its image; phase 8 spec §8) |
| `src/providers/elevenlabs.ts`, `src/voice/hosted.ts`, `assets/voices/elevenlabs.json` | the hosted voice, and which of its voices plays each of the studio's voices in each language |
| `worker-voice/`, `src/voice/`, `src/providers/runpod-voice.ts` | the studio's own voice worker (Python: VoxCPM2 + Whisper; the fallback), laying a script's words over what was heard, the provider |
| `deploy/` | Compose file, Dockerfiles, Caddy files for the server |
| `test/` | pipeline tests: `unit`, `stages`, `media`, `pipeline`, `db` |
| `web/test/`, `web/e2e/`, `web/accounts/`, `web/stack/` | studio tests: vitest, and three Playwright suites |
| `docs/superpowers/specs/`, `docs/superpowers/plans/` | one design spec and one implementation plan per phase |

## Commands

```bash
npm run typecheck          # tsc for the pipeline and for web/
npm test                   # everything in vitest (≈ 10 min; needs ffmpeg; more runs with the items below)
npx vitest run <file>      # one file — the normal loop
npm run test:e2e           # studio in a browser, fixtures + stand-in CLI
npm run test:accounts      # studio with accounts in a browser (needs db:start, redis-server); run it ALONE:
                           # it switches a database-wide setting on for a moment
npm run test:stack         # the Compose stack through the proxy (needs Docker; minutes)
npm run test:db            # database tests only; fails instead of skipping without the local stack
npm run db:start           # the local database: Postgres in Docker (127.0.0.1:54330); applies pending migrations
npm run db:reset           # wipes and reloads the LOCAL database from db/migrations/
npm run web:build          # next build (webpack mode)
npm run db:migrate         # the SERVER's database, over ssh: owner's click, like every server:* command
npm run studio:local       # the OWNER's command: the whole studio on this machine (real provider keys in the
                           # worker). Do not start it yourself without being asked.
npm run make:showcase -- <runId> --slug <name>   # publish a finished run for the landing page (free)
npm run eval:cuts -- <runWith> <runWithout>   # free: compares two finished runs (cut references on / off) by look consistency
npm run eval:prompts -- --cap <usd>   # the OWNER's command: real Gemini calls, scores the prompts against test/eval/baseline.json
npm run test:worker        # Python tests of the RunPod worker (npm run setup:worker once)
```

What a test needs, and what happens without it:

| Needs | Without it |
|---|---|
| the local database (`npm run db:start`) | database, sign-in, tenancy, credit and billing tests are **skipped** |
| `redis-server` on the PATH | queue, worker and account tests are skipped |
| Docker | storage tests (MinIO) are skipped; `test:stack` cannot run |

A skipped test proves nothing: when a change touches accounts, credit, billing or the queue, check the
summary says those tests **ran**. Under a full parallel run, process-timing tests can time out; re-run the
file alone before believing a failure is real, and fix the race if it is one.

No test reaches a provider or Stripe. Stand-ins: `web/test/stub-cli.mjs` (the CLI), `web/test/stripe.ts`
(Stripe, reached through `STRIPE_API_BASE`), `test/fakes/` (providers), MinIO (R2).

## How the pipeline is built

- **Audio drives timing.** The voiceover is generated and silence-trimmed first; every visual is fitted to
  it frame-exactly. Do not make a visual decide a duration.
- **A run is a folder** (`runs/<id>/`) with `manifest.json`. Stages are resumable: each records what it
  bought, with an input hash, so `resume` repeats no paid call. Anything that changes what a stage reads
  must change its hash.
- **Every paid call is recorded before it can be lost.** A provider job is written to the manifest when it
  is submitted (`expectedUsd`), and kept as `abandonedUsd` when given up: there is no moment on disk where
  a paid call is in neither record (`src/stages/job.ts`, `src/stages/inflight.ts`).
- **Budgets:** `--budget` asks before spending more; `--cap` is the hard limit the studio passes. Prices
  come from the table in `src/config.ts`.
- Manifest fields are added as **optional**, so old runs still load (that is what the compat test checks).
- **A run is asked for by its length or by a number of scenes** (phase 7 spec). By its length
  (`request.timing`, `--duration`, `--scene-seconds`; all the studio sends) the script decides how many scenes
  there are, the run is laid out again once it has (`layOutScenes`), and nothing can be given per scene before
  that. The arithmetic is in `src/duration.ts`, which reads nothing and is imported by the browser too: keep it
  that way. A length is a target for the writing, never a duration a visual is made to fit.
- **A video is asked for in a language** (`request.language`; phase 7 spec §13, §17): the script writes what is
  heard in it and what the picture models read in English, and the voice speaks it. Thirty-one languages, each one
  the hosted voice has hundreds of native voices in; the studio's own voice speaks nineteen of them
  (`OWN_VOICE_LANGUAGES`), and without the hosted voice only those are offered. The words a length comes to depend
  on the language (`wordsPerSecond`). **Chinese and Japanese write no spaces**: their length is counted in characters
  and their words found by `Intl.Segmenter` (`src/voice/words.ts`); count and split words through that module, never
  with `split(/\s+/)`. Arabic is set right to left, captions carry the language so capitals follow it (Turkish İ),
  and a script the styles' faces lack is set in its own (`SCRIPT_FACES`, `fontCovers`).
- **New runs are spoken by the hosted voice while `ELEVENLABS_API_KEY` is set** (phase 5 spec §11; the studio's own
  voice is the fallback, and a run stays on the voice it was made with). The studio's voices are roles: the hosted
  voice that plays each, per language, is in `assets/voices/elevenlabs.json`, and the one resolved is part of a
  line's cache key. Its key is the worker's alone. Never clone another service's voices: a reference clip needs a
  recorded consent.
- **A video may be in a niche** (`request.niche` or `nicheText`; phase 7 spec §19, `src/niches.ts`): the script is
  written as videos in it are. Every niche that tells what is so carries `FACT_RULES`, every made-up one
  `FICTION_RULES`; a niche of the user's own is quoted as theirs, never read as instructions. Health, religion,
  politics and money products are left out on purpose: do not add a niche without its rules and their test.
- **A style's name is not sent to the picture worker**: it uses it for nothing and refuses one it was not built
  knowing. Do not put it back.
- **The picture model is chosen per run** (`request.imageProfile`): `runpod-flux3-klein@1` only while
  `RUNPOD_PICTURE3_ENDPOINT` and the four `runpodPicture3*` prices are set; `FLOWCHAIN_IMAGE_MODEL=klein4b` forces the
  Apache 2.0 4B (the fallback if BFL ends the license, phase 10 spec §1). A run keeps its profile. FLUX 3 klein's license
  is the FLUX Kommunity License v.1.0, not Apache: commercial use of Outputs only while revenue is under US$5M (above
  that BFL must grant a license), BFL may terminate it at any time, and nobody trains another model on its pictures.
- **A video is built from four layers chosen apart** (phase 8 spec §1): a niche (what it is about, its rules of
  truth), a type (`src/formats.ts`: how it is told), a style (how a picture is drawn) and an edit (`src/edits.ts`:
  camera, cuts, a finish over the frame). The niche's rules always hold; a type decides the hook and shape; an edit's
  words never name a medium or a colour. A video in one language other than English is made for its viewers
  (`localize`, frozen per run, `src/culture.ts`), and never one that will be made in other languages too.
- **A script of more than 90 seconds is written in parts** (an outline, then each part), each answer checked
  and saved with its charge (`manifest.scriptParts`), so a stopped run buys none again.
- **Every change to a prompt bumps `PROMPT_VERSION`** (`src/providers/prompt-version.ts`; phase 9 spec §4), including a change to a niche, type, edit, culture or preset text; `test/unit/prompt-pin.test.ts` fails without it.

## How the studio is built

- **`route()` wraps every API handler** (`web/server/http.ts`): host check, same-origin check for writes,
  the session, the user's scope, one error shape. A new route goes through it; its `write` flag is tested
  for every route file.
- **Modes by environment, nothing else:** `REDIS_URL` → jobs go through the queue; `DATABASE_URL` →
  accounts (`multiTenant()`); `STRIPE_SECRET_KEY` → payments (`billingOn()`). Without each, that part does
  not exist (404), and the earlier behaviour is unchanged. Tests pin this for every phase.
- **On a server the web app never runs the CLI and holds no provider key.** Only the worker does. One
  worker; a job is **never retried** on its own (a retry could buy twice).
- **The worker checks what it is given.** A command from the queue must match an exact shape
  (`refusal()`, `commandKind()` in `web/server/jobs/redis.ts`); a paid job runs only with an open
  reservation for exactly that user, run, kind and cap.
- Next.js 16 in **webpack mode**; `web/proxy.ts` is the request interceptor. No database client runs in
  the browser: sessions are HttpOnly cookies set by the studio's own routes.

## The landing page (Phase 4)

- **One site, one look: the feed** (phase 4 spec §14 for the one-site rule, §16 for the look): one root layout
  (`web/app/layout.tsx`), one stylesheet (`web/app/theme.css`), one header and foot for the landing page, the
  account forms and the studio; a browser test holds the three to the same background, typeface and wordmark.
  The page is black and the light comes from the videos; the face is the captions' own (Montserrat: `.display`
  for a title in heavy capitals, `.printed` for a part's heading); caption yellow (`signal`, `marker`) is only on
  the thing that is "on" or the action to take, with black text on it; videos and cards have a phone's corners
  and buttons are pills; a part of a page begins under a thin line (`.ruled`), not in a card inside a card.
- **A visitor without a session at `/` is shown `/welcome`** (a rewrite in `web/proxy.ts`). `PUBLIC_PAGES`
  lists what anyone may open; adding to it is a security decision.
- **Every number on the page is computed** (`web/lib/site/calculator.ts`) from a showcase's receipt, the live
  catalogue, or a dated, sourced entry in `web/content/comparison.json`. No figure, count or comparison is
  typed into copy. A claim is shown only while its evidence is (`clipsClaimHolds`, `freshComparisons`).
- **No invented proof:** no testimonials, logos, user counts or avatars until real ones exist.
- **"The real renderer" must stay true:** the page restyles a video by choosing among looks that
  `looksOf()` computed with the studio's own `previewProps`; `web/test/restyle.test.ts` compares every
  combination with it. Do not compute captions, cuts or sounds in the browser.
- **No customer-facing surface names a model, a provider or a key** (phase 5 spec §7), **nor gives the
  studio's own parts a name** (§9.17: no "FlowChain Voice", no "our engine", no "models we use"). Both lists are
  in `web/lib/engines.ts` (`INTERNAL_NAMES`, `SELF_NAMES`), and `web/test/names.test.ts` holds the published
  showcase files and the source of every page, component and shared module to them. In a studio with accounts a
  job's output goes through `publicLog`, and the health answer says that a setting is missing, not which.
  Exceptions on purpose: Stripe where a customer pays; other companies in the dated price comparison.
- **A name the pipeline uses for itself is not shown as it is** (`hormozi`, `tts`, `photorealistic_8k`): the
  studio's words for them are in `web/lib/labels.ts` and `StylePreset.label`. The API and the CLI keep the names.
- Showcases are published by `npm run make:showcase` (free) and listed by hand in
  `web/lib/site/showcases.ts`; what is published must never carry a machine path or a GPU endpoint id.
- A video on the landing page has its sound on from the visitor's first click or key anywhere (a browser allows
  none before); a video out of view stops. Do not unmute a muted Remotion Player: swap it (`ShowcasePlayer`).

## Multi-tenant rules

- The current user lives in a per-request scope (`AsyncLocalStorage`): set by `route()`, by `forUser()`
  for pages, and per job in the worker. `roots()` returns **that user's** folders (`<root>/<userId>`).
  Code that touches run, kit or upload folders outside a scope must throw.
- **A user id in a path or a bucket key comes from the verified session or the job's checked data, never
  from a request.**
- **Something that is not the caller's does not exist: 404, never 403.**
- **Two roles, and what each cannot do** (phase 5 spec §4). The web app connects as `studio_web`: it can
  *read* a user's own rows (row-level security; there is no insert, update or delete policy), run the functions a
  user may run and the sign-in functions (`auth.*`), and nothing else. The worker connects as `studio_worker`:
  it alone runs the functions that move money. Neither owns or writes a table. Every write is a
  `security definer` function with `set search_path = ''`. No running service connects as the owner.
- **The web app tells the database who is asking**: `db().as(userId)` runs each statement in a transaction with
  `app.user_id` set for that transaction only (`src/db/client.ts`); `auth.uid()` reads it. The id comes from
  `userOfSession()` and nowhere else. So the database is safe against a visitor, and against the web app for
  everything that creates or moves credit; it is **not** safe against a web app that lies about who is asking
  (accepted, spec §4.3). Do not widen that: a function that grants, settles or fulfils is never granted to
  `studio_web`, and `test/db/accounts.test.ts` checks every one.
- **The worker's database address lives only in the worker.** `userDb()` is the user's view; `db()` is nobody's
  (sign-in, what any visitor may ask).
- **Sign-in is the studio's own** (`web/server/auth.ts`, `session.ts`): a session is a random secret in an
  HttpOnly cookie, kept in the database as its SHA-256; passwords are scrypt (`src/auth/passwords.ts`). An
  emailed link signs in only the browser that asked for it. The request interceptor only looks whether a
  session cookie is there; whether it is real is decided where data is read (`route()`, `forUser()`).

## Money rules

- **A customer is shown credits, never what a video cost in dollars** (phase 6 spec §12). The database, the
  worker and the pipeline still count in dollars of cost; `amount()` (`web/lib/api.ts`) shows them as credits at
  `CREDITS_PER_USD` wherever the studio has accounts, and as dollars only in the owner's own studio without
  them. `money()` is for real money (a price, a payment). On a page, in a message and in a job's output, a cost
  goes through `amount()` or `inCredits()`: never write `$${…}` for one. An amount typed by a user is typed in
  credits and kept in dollars.
- What a plan is said to cover ("about 5 minutes…") is worked out by `fullyGeneratedMinutes` from the dated
  measurement in `web/content/measured.json`; when a new live check changes the cost, change that file.

- **Credit:** a paid job reserves its approved cap before it is queued; the worker settles at what the
  run's manifest says was spent (ledger + pending `expectedUsd` + `abandonedUsd`). Users cannot cancel a
  reservation. Rounding is to four decimals; compare money in ten-thousandths, never as floats.
- **Two kinds of credit:** plan credit (expires when the next month begins, paid for or granted; spent first) and
  permanent credit (grants; top-ups, which are not on sale now but still work). `plan_credit_usd` is never more than the balance (a trigger keeps it).
- **Payments:** the web verifies Stripe's signature and hands the worker only the event id. The worker
  asks Stripe for the event and its objects, takes the user from `customer.metadata.user_id` and the grant
  from `price.metadata` (`studio=flowchain`, `credit_usd`), and calls one SQL function that records the
  event id with its effect. A payment must name a charge, be in USD, and be at least the credit granted.
- **Only plans are sold** (phase 6 spec §13–§14): by the month, and by the year for the price of ten months.
  A yearly price is its own Stripe price whose `metadata.plan` names the plan and whose `credit_usd` is **one
  month's** credit. Stripe's portal switches between monthly plans only: a change of interval is billed at once
  on an invoice the studio grants nothing for.
- **A year's credit comes a month at a time** (§14). The invoice grants the first month and writes the rest down
  in the same transaction (`fulfil_plan_period`, row in `plan_years`); the worker asks hourly for what is due
  (`grant_plan_month`). That function is the one place credit is granted without a Stripe event: it grants only
  against a row a paid invoice wrote, for a live subscription, on its day, up to the months paid for and not
  refunded, and it moves its own count under the user's lock. Keep every one of those conditions; never give it
  an amount or a date as an argument, and never grant it to `studio_web`.
- Every fulfilment function is **exactly-once by event id** and safe to call again. Keep it that way.
- A change to `settle`, `reserve_credit`, `refund_payment` or `fulfil_*` needs a database test for every
  ordering it could meet; `test/db/billing.test.ts` has a 648-case matrix to extend.

## Series (Phase 6)

- A series is a recipe (the new-video form's choices and a premise) kept as rows of the user's; its videos are
  ordinary runs that name it (`runs.series_id`). Only in a studio with accounts.
- **Built: series by hand, and on a schedule.** "Make the next video" is the ordinary paid
  draft with a topic built by `episodeTopic()` (`web/lib/series.ts`). A series with a schedule is driven by the
  worker (`web/worker/series.ts`): it begins the video that is due and carries it on, queueing the same `draft`
  and `generate` jobs a click queues.
- **A schedule is its owner's standing approval, and their credit is the only limit** (spec §15: the limit for
  one video and the budget for the month were removed at the owner's direction; so was the new-video form's
  budget, and `draftArgs` passes `NO_BUDGET_USD`). The functions that start an episode or hold credit for one
  are the worker's alone, check under a lock on the series' row that it is active and has a schedule, and have
  `reserve_credit` hold the amount in the owner's name for that one call: it is what refuses when the credit is
  not there. Never grant them to `studio_web`; never hold a series' credit any other way.
- **A worker drives a series only when its owner's folder is on its own disk** (`here()`): tests and a local
  studio with real keys share one database, and a row is visible to every worker on it. Do not remove that
  check, and do not add another kind of work that a worker picks up from the database without it.
- A series' video that fails is never retried; the series stops with a reason and waits for its owner.
- **Publishing is to the user's own channel, by their consent** (spec §10). The web app holds the platform
  client's public id only and never sees a token: a consent's code goes to the worker unexchanged; the worker
  alone has the client's secret and `CHANNEL_KEY`, seals the token (`web/worker/vault.ts`) and opens it to post
  (`web/worker/publish.ts`). The web role cannot read `channels` at all. Do not move any of that to the web app.
- A post is a row before the worker is told, is sent once, and what is there is never changed. A series posts
  by itself only when its owner turned "Show me each video first" off.
- **What is real so far** (spec §11): connecting a channel worked against Google itself (the owner's own, on the
  owner's machine, the app in "Testing"); an upload has only ever met the stand-in (`web/test/youtube.ts`,
  through `GOOGLE_TOKEN_URL` and `YOUTUBE_API_BASE`). Publishing the app, the legal pages, Google's verification
  and YouTube's audit are **parked by the owner until there is a server and a domain** (the list is in §11).
  No page says "we post for you" until a real video has reached a real channel.

## Database workflow

- Migrations are plain SQL in `db/migrations/`, applied to the local database by `npm run db:start` /
  `db:reset` and to the server's by `server:setup`, `server:deploy` and `db:migrate` (owner's click). The
  database is always reached through `psql` in its own container (`src/deploy/db-apply.ts`).
- **No server has these migrations yet**, so the first three files have been edited in place. From the first real
  setup on, a file that was applied is frozen: every change is a **new** file. This is enforced: applying
  refuses a file whose content differs from what the database recorded (`pendingMigrations`). Locally, after
  editing a file, `db:start` refuses too: use `db:reset`.
- A new table or function starts with no access for anyone (the first migration closes the defaults): grant
  exactly what each of the two roles needs, in the same file.
- Tests share one local database and run side by side: a test **never wipes it**, makes its own users
  (`newUser`), run ids (`freshRunId`) and Stripe ids (`unique("sub")`), and asserts only on those.
- After editing a migration: `npm run db:reset`, then the database tests **twice** (leftover rows from
  the first run are what the second one finds).

## Conventions

- TypeScript, ESM. `src/`, `scripts/`, `test/` import with `.js` suffixes. `web/` imports itself as `@/…`
  and the pipeline as `@src/…`, without suffixes.
- zod for everything that crosses a boundary (env, manifest, request bodies, files the owner edits).
- **Pure logic is separated from what acts**, and the pure part is what gets tested: `src/deploy/*` vs
  `scripts/*`; `planSetup` vs `applySteps`.
- Comments say **why**, in plain sentences, where the reason is not obvious from the code — what would go
  wrong otherwise. Match the density of the file you are in.
- Tests are named as sentences about behaviour ("grants nothing to a request that Stripe did not sign").
  A test must be able to fail: when adding one for a fix, check it fails without the fix.
- Error text shown to a user never carries a raw provider, Stripe or database message.
- Commit messages: `feat:` / `fix:` / `docs:` / `test:` and one sentence saying what is now true.
- No new dependency without a reason the spec records.

## How work is done here

Each phase: design questions → a spec (`docs/superpowers/specs/`) → a prototype in a scratch clone, one
commit per task → a plan generated from those commits and replayed on a fresh clone
(`docs/superpowers/plans/`) → implementation task by task with reviews → the spec gains a section on what
was found and changed. **In a spec, a later section wins over an earlier one.**

Review findings that are not fixed are written down as rulings or parked items in the spec, never dropped.

## Finding your way in the code (graphify)

A structural graph of the code (TypeScript, Python, SQL) is kept in `graphify-out/` (git-ignored, built
locally from the AST: no API key, no tokens). The binary is `~/.local/bin/graphify`.

```bash
graphify explain "route()"        # a symbol, its callers and callees, with file:line
graphify affected "roots()"       # what a change to it reaches — run before changing a shared function
graphify path "startWorker()" "refusal()"
graphify god-nodes --top 20       # the hubs
```

- **Before trusting it: `graphify check-update .`** (silent when current). If it flags, or the report's
  commit is not `HEAD`, run `graphify update .` first. A stale graph confidently omits new callers.
- To rebuild from nothing: `graphify extract . --code-only` then `graphify cluster-only . --no-label`.
  Never pass `--no-gitignore`. Do not install its git hooks or run `graphify claude install`.
- **It does not see calls made by name.** A SQL function called as `db.rpc("fulfil_topup", …)`, a queue
  job named `"stripe-event"`, a route reached by `fetch("/api/…")`: no edge. For those, `grep` the name.
  SQL functions are in the graph with the tables they read and write, but not with their TypeScript callers.
- Communities are numbered, not named (naming them needs an LLM key; the queries above do not use them).
- Use it for **structure** ("what calls X", "what breaks if X changes"). For **why** something is built
  the way it is, and for anything about money or tenancy rules, read the spec: the graph cannot know.
  Do not use `graphify query` for such questions.

## Where the reasons are

| Area | Spec (`docs/superpowers/specs/`) |
|---|---|
| The pipeline, the manifest, resuming | `2026-10-02-phase1-cli-poc-design.md` |
| Rendering with Remotion | `2026-10-03-phase2.1-remotion-render-engine-design.md` |
| Modes, transitions, style presets | `2026-10-04-phase2.2-content-intelligence-design.md` |
| Hook, sound effects, brand kit, clip lengths | `2026-10-05-phase2.3-retention-brand-design.md` |
| RunPod providers (Wan 2.2; the SDXL pictures it describes are replaced, see phase 5 §9.9–9.11) | `2026-10-05-phase2.4-runpod-providers-design.md` |
| The studio web app and its player | `2026-10-06-phase3.1-web-ui-player-design.md` |
| The queue, the worker, the server | `2026-10-07-phase3.2-job-queue-deployment-design.md` |
| Accounts, credit, storage | `2026-10-07-phase3.3-multi-tenant-design.md` (§14–§15 win) |
| Payments | `2026-10-08-phase3.4-stripe-billing-design.md` (§13–§15 win) |
| The landing page, showcases, welcome credit, the look of the whole site | `2026-10-08-phase4-landing-page-design.md` (the latest of §13–§17 wins) |
| Own database and sign-in, own voice, one GPU provider, unnamed engines | `2026-10-09-phase5-independence-design.md` |
| A video's length, scene seconds, what it is made of; scripts written in parts | `2026-10-10-phase7-length-design.md` (built against fakes; no real script yet) |
| Series and their schedule, publishing to a channel, credits, plans | `2026-10-10-phase6-series-autopublish-design.md` (built against stand-ins) |
| Niche, video type, style and edit as four layers; versions in other languages; a video made for its audience | `2026-10-15-phase8-layers-languages-design.md` |
| The prompts Gemini is given: version, audit, eval harness | `2026-10-18-phase9-prompt-audit-design.md` |
| FLUX 3 klein as the picture model; reframe cuts and the shared look | `2026-10-18-phase10-flux3-reframe-design.md` |

The README is the owner's manual: setup, usage, costs, and what to know about each part.

## What is and is not live (2026-10-09)

Verified only against local stand-ins: the server deployment (its database included), the R2 bucket for runs,
email (written to a folder in tests) and Google sign-in.
Verified against the real thing: the pipeline on the studio's own three GPU endpoints (pictures, clips, voice;
spec phase 5 §9.6–9.8, §9.12); Stripe **test mode** (setup, Checkout, renewal, portal, refunds — spec 3.4 §15).
Nothing is deployed to a server, and Stripe live mode has never been used.
