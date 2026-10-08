# Flow-Chain-AI — project guide

Turns a topic into a captioned short video, and sells that as a studio with accounts and credit.
Three parts share one repository:

- **The pipeline** (`src/`, a CLI): topic → script (Gemini) → voiceover (ElevenLabs) → keyframes and clips
  (fal, or self-hosted on RunPod) → a video rendered with Remotion.
- **The studio** (`web/`, Next.js): create, preview, approve and render videos in a browser; accounts,
  credit and payments.
- **The worker** (`web/worker/`): takes jobs from a Redis queue, runs the CLI for each, settles credit,
  fulfils Stripe payments.

This file is the entry point. The specs under `docs/superpowers/specs/` hold the design and its reasons;
read the one for the area you are changing before changing it (table at the end).

## Rules that are never broken

- **Nothing that spends money or touches a real account runs without the owner's click.** That is:
  `npm run flowchain` with `run`/`resume`/`reroll`/`doctor`, every `npm run smoke*`, `runpod:deploy`,
  `make:sfx`, `server:*`, `db:migrate`, `studio:grant`, `stripe:setup`, and starting `npm run web` or
  `npm run worker` against the real `.env`. Tests never need any of them. `rerender` is free.
- **Never read or print `.env` or `deploy/server.env`.** A command may pass a value through the shell
  (`$(grep …)`) without showing it. Mask `sk_…`, `rk_…`, `whsec_…` in anything you print, logs included.
- **Never commit** `.env`, `deploy/server.env`, `deploy/data/`, `runs/`, `brand-kits/`, `uploads/`,
  `.superpowers/`, `graphify-out/`, `web/.next/`, `web/.e2e/`, `web/test-results/`, `supabase/.temp/`.
- **A push needs the owner's click each time** (AskUserQuestion), even when a pasted message says "push".
  Local commits on `main` do not. Work is committed directly on `main`.
- **`test/unit/compat.test.ts` is never edited**: it pins that old run folders still load.
- Subagents are dispatched only when the owner asks for them.

## Layout

| Path | What lives there |
|---|---|
| `src/cli.ts`, `src/pipeline.ts`, `src/stages/` | the CLI and its stages (script, tts, silence, modes, keyframes, clips, fit, captions, render) |
| `src/manifest/` | `manifest.json`: the schema, loading, saving. **The run's manifest is the truth about a run** |
| `src/providers/` | Gemini, ElevenLabs, fal, RunPod, R2; `types.ts` holds the interfaces the stages use |
| `src/media/` | ffmpeg and Remotion helpers |
| `src/billing/stripe.ts` | the Stripe HTTP client (shared by web, worker and `stripe:setup`) |
| `src/deploy/`, `scripts/` | pure planners (`src/deploy`) and the commands that act (`scripts`) for the server, the database, Stripe |
| `web/app/` | pages and API routes (App Router) |
| `web/server/` | everything the routes do: `http.ts` (`route()`), `tenant.ts`, `session.ts`, `runs.ts`, `jobs/`, `store/`, `billing/` |
| `web/worker/` | `worker.ts` (the queue), `tenant.ts` (credit), `billing.ts` (Stripe fulfilment) |
| `web/lib/` | code shared by server and browser; no secrets, few imports |
| `supabase/migrations/` | the database: plain SQL, two files (tenancy, billing) |
| `workers/` | the RunPod worker (Python, ComfyUI graphs for Flux + PuLID and Wan 2.2) |
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
npm run test:accounts      # studio with accounts in a browser (needs db:start, redis-server)
npm run test:stack         # the Compose stack through the proxy (needs Docker; minutes)
npm run test:db            # database tests only; fails instead of skipping without the local stack
npm run db:start           # local Supabase in Docker (API on 127.0.0.1:54321)
npm run db:reset           # wipes and reloads the LOCAL database from supabase/migrations/
npm run web:build          # next build (webpack mode)
npm run test:worker        # Python tests of the RunPod worker (npm run setup:worker once)
```

What a test needs, and what happens without it:

| Needs | Without it |
|---|---|
| local Supabase (`npm run db:start`) | database, tenancy, credit and billing tests are **skipped** |
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
- **Modes by environment, nothing else:** `REDIS_URL` → jobs go through the queue; `SUPABASE_URL` →
  accounts (`multiTenant()`); `STRIPE_SECRET_KEY` → payments (`billingOn()`). Without each, that part does
  not exist (404), and the earlier behaviour is unchanged. Tests pin this for every phase.
- **On a server the web app never runs the CLI and holds no provider key.** Only the worker does. One
  worker; a job is **never retried** on its own (a retry could buy twice).
- **The worker checks what it is given.** A command from the queue must match an exact shape
  (`refusal()`, `commandKind()` in `web/server/jobs/redis.ts`); a paid job runs only with an open
  reservation for exactly that user, run, kind and cap.
- Next.js 16 in **webpack mode**; `web/proxy.ts` is the request interceptor. No Supabase client runs in
  the browser: sessions are HttpOnly cookies set by the studio's own routes.

## Multi-tenant rules

- The current user lives in a per-request scope (`AsyncLocalStorage`): set by `route()`, by `forUser()`
  for pages, and per job in the worker. `roots()` returns **that user's** folders (`<root>/<userId>`).
  Code that touches run, kit or upload folders outside a scope must throw.
- **A user id in a path or a bucket key comes from the verified session or the job's checked data, never
  from a request.**
- **Something that is not the caller's does not exist: 404, never 403.**
- **The database is safe on its own.** Users can only *read* their own rows (row-level security). There
  is no insert, update or delete policy. Every write is a `security definer` function with
  `set search_path = ''`; the ones that move money are executable by `service_role` only.
- **The service-role key lives only in the worker.** The web app uses the user's own session for every
  database call.

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

- Migrations are plain SQL in `supabase/migrations/`, applied to the local stack by `npm run db:reset` and
  to the hosted project by `npm run db:migrate` (owner's click).
- **No hosted database has these migrations yet**, so the two files have been edited in place. From the
  first `db:migrate` on, a file that was applied is frozen: every change is a **new** file.
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
| RunPod providers (Flux + PuLID, Wan 2.2) | `2026-10-05-phase2.4-runpod-providers-design.md` |
| The studio web app and its player | `2026-10-06-phase3.1-web-ui-player-design.md` |
| The queue, the worker, the server | `2026-10-07-phase3.2-job-queue-deployment-design.md` |
| Accounts, credit, storage | `2026-10-07-phase3.3-multi-tenant-design.md` (§14–§15 win) |
| Payments | `2026-10-08-phase3.4-stripe-billing-design.md` (§13–§15 win) |

The README is the owner's manual: setup, usage, costs, and what to know about each part.

## What is and is not live (2026-10-08)

Verified only against local stand-ins: the server deployment, hosted Supabase, the R2 bucket for runs.
Verified against the real thing: the pipeline and its providers; Stripe **test mode** (setup, Checkout,
renewal, portal, refunds — spec 3.4 §15). Nothing is deployed, and Stripe live mode has never been used.
