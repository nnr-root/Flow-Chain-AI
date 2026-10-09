# Flow-Chain-AI — project guide

Turns a topic into a captioned short video, and sells that as a studio with accounts and credit.
Three parts share one repository:

- **The pipeline** (`src/`, a CLI): topic → script (Gemini) → voiceover, keyframes and clips
  (all three on the studio's own RunPod endpoints) → a video rendered with Remotion.
- **The studio** (`web/`, Next.js): create, preview, approve and render videos in a browser; accounts,
  credit and payments.
- **The worker** (`web/worker/`): takes jobs from a Redis queue, runs the CLI for each, settles credit,
  fulfils Stripe payments.

This file is the entry point. The specs under `docs/superpowers/specs/` hold the design and its reasons;
read the one for the area you are changing before changing it (table at the end).

## Rules that are never broken

- **Nothing that spends money or touches a real account runs without the owner's click.** That is:
  `npm run flowchain` with `run`/`resume`/`reroll`/`doctor`, every `npm run smoke*`, `runpod:deploy`, `voice:deploy`,
  `make:sfx`, `server:*`, `db:migrate`, `studio:grant`, `studio:welcome`, `stripe:setup`, and starting `npm run web` or
  `npm run worker` against the real `.env`. Tests never need any of them. `rerender` is free.
- **Never read or print `.env` or `deploy/server.env`.** A command may pass a value through the shell
  (`$(grep …)`) without showing it. Mask `sk_…`, `rk_…`, `whsec_…` in anything you print, logs included.
- **Never commit** `.env`, `deploy/server.env`, `deploy/data/`, `runs/`, `brand-kits/`, `uploads/`,
  `.superpowers/`, `graphify-out/`, `web/.next/`, `web/.e2e/`, `web/test-results/`.
- **A push needs the owner's click each time** (AskUserQuestion), even when a pasted message says "push".
  Local commits on `main` do not. Work is committed directly on `main`.
- **`test/unit/compat.test.ts` is never edited**: it pins that old run folders still load.
- Subagents are dispatched only when the owner asks for them.

## Layout

| Path | What lives there |
|---|---|
| `src/cli.ts`, `src/pipeline.ts`, `src/stages/` | the CLI and its stages (script, tts, silence, modes, keyframes, clips, fit, captions, render) |
| `src/manifest/` | `manifest.json`: the schema, loading, saving. **The run's manifest is the truth about a run** |
| `src/providers/` | Gemini, RunPod (pictures, clips, voice), R2; `types.ts` holds the interfaces the stages use |
| `src/media/` | ffmpeg and Remotion helpers |
| `src/billing/stripe.ts` | the Stripe HTTP client (shared by web, worker and `stripe:setup`) |
| `src/deploy/`, `scripts/` | pure planners (`src/deploy`) and the commands that act (`scripts`) for the server, the database, Stripe |
| `web/app/(studio)/` | the studio's pages (dark); `web/app/api/`, `web/app/auth/`: route handlers |
| `web/app/(marketing)/` | the landing page, `/pricing`, `/terms`, `/privacy` (light): **its own root layout, CSS and fonts** |
| `web/components/site/`, `web/lib/site/`, `web/public/showcase/`, `web/content/` | the landing page's parts, its arithmetic, the published videos, other companies' dated prices |
| `web/server/` | everything the routes do: `http.ts` (`route()`), `tenant.ts`, `session.ts`, `runs.ts`, `jobs/`, `store/`, `billing/` |
| `web/worker/` | `worker.ts` (the queue), `tenant.ts` (credit), `billing.ts` (Stripe fulfilment) |
| `web/lib/` | code shared by server and browser; no secrets, few imports |
| `db/migrations/` | the database: plain SQL, three files (accounts, tenancy, billing) |
| `src/db/client.ts`, `src/auth/` | the one client for the studio's Postgres (`Db`), and password hashing |
| `workers/` | the clip worker (Python, a ComfyUI graph for Wan 2.2 at 480p and 720p; its SDXL picture graph serves no new run) |
| `worker-picture/` | the picture worker (Python, FLUX.2 klein 4B through diffusers; weights on the network volume) |
| `worker-voice/`, `src/voice/`, `src/providers/runpod-voice.ts` | the voice worker (Python: VoxCPM2 + Whisper), laying a script's words over what was heard, the provider |
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

- **Two root layouts.** Nothing under `(marketing)` imports the studio's `globals.css` or components styled
  for it, and the reverse; a browser test checks backgrounds and typefaces on both sides. Going from one
  side to the other is a full page load, on purpose.
- **A visitor without a session at `/` is shown `/welcome`** (a rewrite in `web/proxy.ts`). `PUBLIC_PAGES`
  lists what anyone may open; adding to it is a security decision.
- **Every number on the page is computed** (`web/lib/site/calculator.ts`) from a showcase's receipt, the live
  catalogue, or a dated, sourced entry in `web/content/comparison.json`. No figure, count or comparison is
  typed into copy. A claim is shown only while its evidence is (`clipsClaimHolds`, `freshComparisons`).
- **No invented proof:** no testimonials, logos, user counts or avatars until real ones exist.
- **"The real renderer" must stay true:** the page restyles a video by choosing among looks that
  `looksOf()` computed with the studio's own `previewProps`; `web/test/restyle.test.ts` compares every
  combination with it. Do not compute captions, cuts or sounds in the browser.
- **No customer-facing surface names a model, a provider or a key** (phase 5 spec §7). The names customers are
  given are in `web/lib/engines.ts` (`ENGINES`); the names they are never given are in `INTERNAL_NAMES` there, and
  `web/test/names.test.ts` holds the published showcase files and the source of every page, component and
  shared module to it. In a studio with accounts a job's output goes through `publicLog`, and the health answer
  says that a setting is missing, not which. The copy says "our engine": never "proprietary" or "built by us".
  Exceptions on purpose: Stripe where a customer pays; other companies in the dated price comparison.
- Showcases are published by `npm run make:showcase` (free) and listed by hand in
  `web/lib/site/showcases.ts`; what is published must never carry a machine path or a GPU endpoint id.
- Design: the spec's §3 (and its amended list of banned details) is binding for anything on this side.

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

- **Credit:** a paid job reserves its approved cap before it is queued; the worker settles at what the
  run's manifest says was spent (ledger + pending `expectedUsd` + `abandonedUsd`). Users cannot cancel a
  reservation. Rounding is to four decimals; compare money in ten-thousandths, never as floats.
- **Two kinds of credit:** plan credit (expires when the next month is paid for, spent first) and
  permanent credit (top-ups, grants). `plan_credit_usd` is never more than the balance (a trigger keeps it).
- **Payments:** the web verifies Stripe's signature and hands the worker only the event id. The worker
  asks Stripe for the event and its objects, takes the user from `customer.metadata.user_id` and the grant
  from `price.metadata` (`studio=flowchain`, `credit_usd`), and calls one SQL function that records the
  event id with its effect. A payment must name a charge, be in USD, and be at least the credit granted.
- Every fulfilment function is **exactly-once by event id** and safe to call again. Keep it that way.
- A change to `settle`, `reserve_credit`, `refund_payment` or `fulfil_*` needs a database test for every
  ordering it could meet; `test/db/billing.test.ts` has a 648-case matrix to extend.

## Database workflow

- Migrations are plain SQL in `db/migrations/`, applied to the local database by `npm run db:start` /
  `db:reset` and to the server's by `server:setup`, `server:deploy` and `db:migrate` (owner's click). The
  database is always reached through `psql` in its own container (`src/deploy/db-apply.ts`).
- **No server has these migrations yet**, so the three files have been edited in place. From the first real
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
| The landing page, showcases, welcome credit | `2026-10-08-phase4-landing-page-design.md` (§13 wins) |
| Own database and sign-in, own voice, one GPU provider, unnamed engines | `2026-10-09-phase5-independence-design.md` |

The README is the owner's manual: setup, usage, costs, and what to know about each part.

## What is and is not live (2026-10-09)

Verified only against local stand-ins: the server deployment (its database included), the R2 bucket for runs,
email (written to a folder in tests) and Google sign-in.
Verified against the real thing: the pipeline on the studio's own three GPU endpoints (pictures, clips, voice;
spec phase 5 §9.6–9.8, §9.12); Stripe **test mode** (setup, Checkout, renewal, portal, refunds — spec 3.4 §15).
Nothing is deployed to a server, and Stripe live mode has never been used.
