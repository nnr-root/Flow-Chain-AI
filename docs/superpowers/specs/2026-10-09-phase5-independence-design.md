# Phase 5 — Independence: own database and sign-in, own voice, one GPU provider, unnamed engines

**Date:** 2026-10-09 · **Status:** approved by the owner (research report and migration plan, both by click)

## 1. Goal

Remove every provider the studio does not need, and stop naming the ones that remain:

- the database and sign-in run in the studio's own Compose stack (no Supabase, hosted or otherwise);
- the voiceover is made on the studio's own GPU worker (no ElevenLabs);
- pictures and clips are made only on the studio's own GPU worker (no fal);
- no customer-facing surface names a model or a vendor behind the engines;
- the GPU worker makes a privacy promise it can keep.

### Non-goals

- Replacing Gemini for the script. The owner decides after this phase (it is the one content provider left).
- Replacing Stripe, Cloudflare R2 or RunPod. They stay; R2 access is already direct (`aws4fetch`, no Supabase Storage).
- Dedicated or owned GPU hardware. The worker stays serverless; the plan keeps it movable.

## 2. Decisions (owner's clicks, 2026-10-09)

| # | Decision |
|---|---|
| D1 | Voice: build on **VoxCPM2** (Apache 2.0), **Chatterbox Multilingual V3** (MIT) as fallback. ElevenLabs stays selectable until a listening test of the owner's own scripts in Turkish and English passes. |
| D2 | A measured benchmark, **up to $5** of RunPod credit, precedes the model choices in §6. |
| D3 | Gemini: decided after the phase. |
| D4 | GPU privacy: **hardened serverless** in a Secure Cloud region. |
| D5 | Database: **plain Postgres + own sign-in**, with the web/worker role split, accepting the trade in §4.3. |
| D6 | Email: an **SMTP service** set by address and password in the server settings. |
| D7 | Google sign-in is **kept**, implemented directly against Google. |
| D8 | Public names: **FlowChain Voice**, **FlowChain Picture**, **FlowChain Motion**. |

## 3. Order of work

Each piece lands on `main` on its own, with its own review. A later piece never blocks an earlier one.

1. **Benchmark** (§6.4): throwaway code, kept out of the repository; its findings are written into §9.
2. **Names** (§7) and **fal purge** (§5.1): independent of everything else.
3. **Database and sign-in** (§4): the largest piece; own prototype and whole-branch review.
4. **Voice worker** (§6.1), then the **ElevenLabs purge** (§5.2) once D1's test passes.
5. **Model upgrade** (§6.2–6.3) and **worker hardening** (§8).

## 4. Database and sign-in

### 4.1 What exists

About 25 call sites, behind three seams: `userDb()` (the visitor's own session, through PostgREST), the
service-role client in `web/worker/{tenant,billing}.ts` and the two admin scripts, and
`web/server/{session,auth}.ts` + `web/proxy.ts` for sign-in. The SQL uses `auth.users`, `auth.uid()` and the roles
`anon` / `authenticated` / `service_role` (54 places). The Compose stack has no database.

### 4.2 Design

- **Postgres 17** as a Compose service on the `back` network only, data in a named volume, a nightly `pg_dump` to
  the backup bucket (the same job that backs up runs). `npm run db:start` starts the same image locally;
  `db:reset` reloads `supabase/migrations/` renamed to `db/migrations/`. No hosted database has the two
  files, so they are still edited in place; the freeze rule in `CLAUDE.md` starts with the first real deployment.
- **Roles.** `studio_web`: may `select` through row-level security and execute the user functions, nothing else.
  `studio_worker`: may execute the money functions (`settle`, `grant_credit`, `fulfil_*`, `refund_payment`,
  `end_subscription`, `link_stripe_customer`, `set_run_state`) and read what it reads today. Neither owns a table.
  Migrations run as the owner role, which no running service uses.
- **Who the caller is.** `app.uid()` replaces `auth.uid()`: it reads `current_setting('app.user_id', true)`.
  The web app's database helper opens a transaction, runs `select set_config('app.user_id', $1, true)` with the id
  from the verified session, runs the query, commits. The setting is transaction-local, so a pooled connection
  can never carry one visitor's identity into another's query. A query outside that helper has no user and sees
  no rows.
- **Sign-in.** Tables `users` (gains `password_hash`, `email_confirmed_at`, `google_sub`), `sessions`
  (`token_hash`, `user_id`, `expires_at`, `created_at`) and `email_tokens` (`token_hash`, `user_id`, `purpose`,
  `expires_at`, single use). The cookie carries a 256-bit random token; the database stores its SHA-256. Passwords:
  Node's `scrypt` with a per-user salt and parameters stored beside the hash, compared in constant time. Sign-in
  and reset answer the same way whether or not the address exists. Changing a password ends every other session.
- **Google.** Authorization-code flow with PKCE and a `state` cookie, by `fetch`; the id token's signature is
  verified against Google's published keys; an account is matched by Google's `sub`, and by email only when
  Google says the email is verified.
- **Email.** `nodemailer` over SMTP (`SMTP_URL`, `MAIL_FROM`). Without `SMTP_URL` on a server, accounts cannot be
  enabled (the deploy check refuses), because unconfirmed sign-up is how the welcome credit would be farmed.
  Locally and in tests, mail is written to a folder.
- **Modes.** `DATABASE_URL` replaces `SUPABASE_URL` as the switch for accounts (`multiTenant()`).
- **Dependencies:** `pg` and `nodemailer` added; `@supabase/supabase-js`, `@supabase/ssr`, `supabase` removed.

### 4.3 The trade (accepted, D5)

Today the database verifies each visitor's signed token itself. After this change the web app tells the database
who the visitor is. A compromised web app can then read any user's rows and reserve any user's credit. It still
cannot grant credit, settle, or fulfil a payment: those belong to `studio_worker`, whose password the web app
never holds. `CLAUDE.md`'s rule "the database is safe on its own" becomes "the database is safe against a
visitor, and against the web app for everything that creates or moves credit".

### 4.4 Tests

Every database test is ported and keeps its meaning: tenancy, credit, the 648-case billing matrix, welcome credit.
New: a user function called with no `app.user_id` fails; `studio_web` cannot execute a money function or write a
table; two interleaved requests on one pooled connection never see each other's rows; session expiry, reuse of a
spent email token, password change ending other sessions, Google callback with a wrong `state`.

## 5. Purge

### 5.1 fal (now)

Removed: `src/providers/fal.ts`, `@fal-ai/client`, `FAL_*`, `PROVIDER_MODE`, the fal branch of estimates and of
`doctor`, the studio's engine switch (`STUDIO_ENGINE`, the per-run provider choice in the new-video form).
Kept, as data only: the image and video profiles (`fal-flux@1`, the Kling profiles) and price fields that old run
folders name, so the nine existing runs load and re-render. An old fal run can no longer be resumed or rerolled:
the command says so. `test/unit/compat.test.ts` is not edited and must pass.

### 5.2 ElevenLabs (after D1's test)

Removed: `src/providers/elevenlabs.ts`, `ELEVENLABS_*`, its `doctor` check. Kept as data: `ttsPer1kChars` for old
runs' recorded costs.

## 6. Voice and models

### 6.1 Voice worker

- A third RunPod endpoint, `voice`, in the same template family. One job takes the whole script's lines, a
  language and a voice; it returns one audio file per scene and **word timings**.
- Word timings come from forced alignment of the known text against the generated audio (the candidate is
  Whisper-based alignment, MIT; the benchmark confirms it for Turkish). Audio drives every duration in the
  pipeline, so a line whose alignment fails is regenerated, never guessed.
- A voice is a named entry in a library the studio owns: either a description (voice design) or a reference clip
  with recorded consent. No voice is cloned from an upload in this phase.
- It sits behind the existing `TtsProvider` interface; the `tts` stage's input hash gains the voice engine.
- Price profile: seconds of GPU × rate, as for keyframes and clips.

### 6.2 Pictures

Candidates: **FLUX.2 klein 4B** (Apache 2.0, up to four reference images) and **Z-Image Turbo** (Apache 2.0),
against today's SDXL with IP-Adapter. Excluded by licence: FLUX.1/FLUX.2 dev, Qwen-Image 2.1.
Chosen by the benchmark on the six presets and on identity across scenes.

### 6.3 Clips

Wan 2.2 I2V A14B stays (the newest Wan with open weights; Apache 2.0). The change is 480p → 720p, on whichever
card the benchmark shows cheapest per clip. LTX-2.5 is measured beside it but is not a default (licence with a
revenue threshold; unstable camera in published tests). MiniMax H3 is excluded (territory limits, mandatory
naming).

### 6.4 Benchmark (D2)

Three jobs on temporary RunPod pods that end themselves, results to the R2 bucket:
voice (VoxCPM2 and Chatterbox V3, Turkish and English, a short line and a 20-second narration, with alignment);
pictures (the two candidates on real prompts from an existing run); clips (480p and 720p from an existing
keyframe on a 24, a 32 and a 48 GB card). Budget $5; a watchdog removes any pod older than 30 minutes.

### 6.5 Hardware

RunPod serverless, per hour: RTX 4090 $1.10, A6000/A40 $1.22, RTX 5090 $1.58, L40S $1.75, A100 $2.72, H100 $4.79.
An H100 must be 4.4× faster than a 4090 to cost the same per clip, an A100 2.5×. Neither is planned.

## 7. Names

- `web/lib/engines.ts` maps each stage to its public name (D8). The new-video form, the brand-kit form, the
  landing page, the FAQ, receipts and `make:showcase` read from it; a test fails when a vendor or model name
  appears in anything a browser is sent (pages, JSON under `web/public/showcase/`, API answers).
- Exceptions, on purpose: Stripe where a customer pays; other companies in the dated price comparison.
- The copy says "our engine". It never says "proprietary", "built by us", "trained by us" or a resolution the
  output does not have ("Ultra-HD" means 4K).
- The privacy page names categories of processors ("GPU hosting", "payments", "storage"), which GDPR allows.
- The published showcases are re-exported so their receipts carry the new names; their costs do not change.
- Customer terms must still pass on the model licences' use restrictions where one applies (OpenRAIL++-M while
  SDXL is in use); that is text for the terms page, without naming the model.

## 8. Worker privacy

What the provider states: containers on shared hosts (not virtual machines); a worker's disk is erased when it
stops; job payloads are kept 30 minutes; endpoint logs 90 days; FlashBoot keeps worker state after spin-down.

Changes:
- after every job: ComfyUI's history and node cache are cleared and its `input`, `temp` and `output` folders
  emptied, on every path, before the handler answers;
- the network volume holds weights only and is mounted read-only where the platform allows; a test asserts the
  worker never writes under it outside `fetch-models`;
- no prompt, script line or file name reaches a log line (a test greps the handler's output);
- objects the worker uploads expire after 24 hours (a bucket lifecycle rule set by the deploy command);
- the endpoints are pinned to Secure Cloud data centres; FlashBoot is turned off unless the benchmark shows the
  cold-start cost is unacceptable, in which case the reason is recorded here.

The promise the studio may publish: content is processed in scratch space that is deleted when each job ends;
nothing is kept at the GPU host; job data is held there for at most 30 minutes; content is never logged and never
used for training. It may not publish "zero persistence" or "memory is flushed immediately": neither can be
proven on hardware the studio does not control.

## 9. Findings

(Each piece adds its section here when it lands. A later section wins over an earlier one.)

## 10. Sources (read 2026-10-09)

RunPod: pricing page; docs "Data security and legal compliance", "Endpoint settings"; guide "Keep data secure on
cloud GPUs". Wiz, CVE-2025-23266. VoxCPM2 and Chatterbox model cards; "A Comprehensive Objective Evaluation of
Modern Text-to-Speech for Turkish" (arXiv 2610.06057). Wan-Video on GitHub; fuser.studio licence comparison;
zenn.dev LTX-2.3 vs Wan 2.2 benchmark. FLUX.2 klein 4B model card; thundercompute.com image model comparison.
