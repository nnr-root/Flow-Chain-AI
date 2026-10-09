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

### 9.1 fal purge and names (2026-10-09)

Landed directly on `main`, two commits.

- **fal is gone from everything that runs.** `src/providers/fal.ts`, `@fal-ai/client`, `FAL_*`, `PROVIDER_MODE`,
  `--provider`, the form's provider choice and `STUDIO_ENGINE` are removed. A run whose model ids are not
  `runpod:…` gets a stand-in provider (`retired()` in `src/providers/factory.ts`) that refuses `prepare`, `submit`
  and `wait` with one sentence; such a run needs no key, loads and re-renders. `serverConfig` and `localEnvs`
  drop `RETIRED_KEYS`, so a `FAL_KEY` still written in an owner's `.env` is handed to no process.
- **Kept as data:** the `fal-flux@1`, `kling-v1`, `kling-v2` profiles and the three price fields, with comments
  saying why. `NEW_RUN_VIDEO_PROFILE` is now `wan22-480p@1`. `test/unit/compat.test.ts` is untouched and passes.
- **Names.** `web/lib/engines.ts` holds `ENGINES` (D8) and `INTERNAL_NAMES`. A published receipt no longer has
  `engines`; it keeps `madeOn` (`own` | `hosted`) and gains `clipHeight`, read from the graph's name. The three
  published receipts were rewritten to that shape (same runs, same ledgers).
- **Found while doing it, and closed:**
  - the studio showed a customer the pipeline's raw output ("Job output"), which names providers, models,
    endpoint ids and provider error text. With accounts it now goes through `publicLog`: a line that names an
    internal is replaced whole. The owner's local studio still shows it as it is;
  - `/api/health` listed the names of unset keys to any signed-in user; with accounts it now answers
    `["not_ready"]`, and the draft route says "the studio is not ready to make videos yet";
  - `"gemini"` was a value in the form's API (`hook.mode`) and in a run's status (`style.source`): both are
    `"auto"` now.
- **The landing page has one way of making a video.** The calculator lost its engine choice; its per-video
  figure is the mean of the showcases made on the studio's own GPU. The showcase made on rented models stays on
  the shelf with its receipt, carries no engine name, and is not counted. The headline's claim no longer
  depends on a setting: it holds while a video on the page was made the current way and the comparison holds.
- **Tests:** `web/test/names.test.ts` (published files; the source of `web/app`, `web/components`, `web/lib` with
  comments and import lines removed; the scanner's own ability to fail; `publicLog`; the readiness answer).
- **Not done here:** `web/lib/supabase/settings.ts` and `web/lib/billing.ts` are exempt from the source scan until
  §4 replaces them. The CLI's own help text and the README name providers: they are the owner's, not a customer's.

## 10. Sources (read 2026-10-09)

RunPod: pricing page; docs "Data security and legal compliance", "Endpoint settings"; guide "Keep data secure on
cloud GPUs". Wiz, CVE-2025-23266. VoxCPM2 and Chatterbox model cards; "A Comprehensive Objective Evaluation of
Modern Text-to-Speech for Turkish" (arXiv 2610.06057). Wan-Video on GitHub; fuser.studio licence comparison;
zenn.dev LTX-2.3 vs Wan 2.2 benchmark. FLUX.2 klein 4B model card; thundercompute.com image model comparison.

### 9.2 Own database and sign-in (2026-10-09)

Landed directly on `main`. Supabase is gone: no package, no folder, no setting, no word of it in code.

- **Shape.** `db/migrations/` has three files: `accounts` (new: the two roles, the `auth` schema, its
  functions), `tenancy` and `billing` (carried over; only who may do what changed). The money SQL is untouched,
  and its tests, the 648-case matrix included, pass on plain Postgres 17 as they were written.
- **Roles (differs from §4.2 in one way).** There is no separate role for a visitor and a member: `studio_web`
  is both, and a statement without `app.user_id` is nobody (the functions refuse it, row-level security shows
  it nothing). `studio_worker` has `bypassrls`, select on the four tables it reads, and no table write: less
  than the old service role, which could write every table.
- **One client** (`src/db/client.ts`, `Db`): `rpc`, `from(...)` and `query`, shaped like the calls the code
  already made, so call sites and tests changed little. `as(userId)` wraps each statement in its own
  transaction with `app.user_id` set locally.
- **Sign-in.** As §4.2, with these decisions made while building:
  - *Google's id token is not signature-checked.* It is taken straight from Google's token address over TLS,
    in answer to this server's own request with its secret; its issuer, audience, expiry, nonce and
    `email_verified` are checked. This is what OpenID Connect Core §3.1.3.7 allows for the code flow, and it
    replaces §4.2's "verified against Google's published keys".
  - *An emailed link signs in only the browser that asked for it* (a second secret in an HttpOnly cookie, its
    hash stored with the link). Opened elsewhere, a confirmation link confirms the address and sends the
    visitor to sign in; a reset link does nothing and is not used up. This keeps the rule the earlier design
    had: a link cannot be made by one person to sign another into the maker's account.
  - *An account nobody confirmed belongs to whoever proves the mailbox*: a later sign-up or a Google sign-in
    with that address replaces its password and ends its links and sessions.
  - *No limit per address on signing in* (it would let anyone lock a user out); guessing is limited per
    visitor. One address is sent at most three emails an hour.
  - *Without a mail server an account works at once*, and a sign-up for a taken address is refused in words
    (it cannot be answered like a new one without signing someone into another's account). On a server
    `serverConfig` refuses accounts without `SMTP_URL` and `MAIL_FROM`.
  - The request interceptor no longer checks the session: it looks whether the cookie is there. Whether it is
    real is decided by `route()` and `forUser()`, which ask the database. A made-up cookie reaches the login
    page and a 401, which the browser test checks.
- **Server.** `STUDIO_ACCOUNTS=1` turns accounts on. `server:setup` makes the three passwords once (kept in
  `db.env` on the server), starts the `db` service alone, applies the migrations of the deployed commit through
  `psql` in the database's own container, sets the two roles' passwords, then starts the rest. `server:deploy`
  and `db:migrate` do the same migration step. `studio:grant` and the new `studio:welcome` reach the database
  the same way. The nightly backup takes a `pg_dump` first.
- **Enforced now:** an applied migration whose file changed is refused (`pendingMigrations`).
- **Found by the tests, and fixed:**
  - a database container answers its health check before it has made its database; `migrate` now waits for
    the first statement to succeed (found by `test:stack`);
  - inside its own container the Postgres image trusts loopback connections without a password. Nothing else
    runs there, and the services connect over the private network, where the password is required (the stack
    test checks a wrong one is refused);
  - a function named like an SQL keyword (`session_user`) was renamed `whose_session`.
- **Tests:** `test/db/accounts.test.ts` (23: the roles' walls, identity per statement on one shared
  connection, every sign-in function), `test/unit/db-migrations.test.ts` (13), sign-in through the real routes
  with email written to a folder and a stand-in for Google's token address (`web/test/tenancy.test.ts`), a
  third whole-stack test (migrations through Compose, role limits, no published port, the proxy cannot reach
  the database). Suite at this point: vitest 86+ files / about 800 tests; studio browser 6; accounts browser 4;
  stack 3.
- **Not done / to know:**
  - the trade of §4.3 stands as accepted;
  - no "sign out everywhere", no change of address, no deleting an account in the studio;
  - emails are plain text;
  - Google sign-in and SMTP have only been run against stand-ins;
  - nothing here has run on a real server yet.

### 9.3 Voice: benchmark and worker, before its live check (2026-10-09)

**Benchmark** (D2; one RTX 4090 pod, five starts, about $0.30 in all). Both engines read six texts in English
and Turkish; a Whisper model listened.

| | VoxCPM2 | Chatterbox Multilingual V3 |
|---|---|---|
| GPU seconds per second of speech | 0.28 | 0.26 |
| GPU memory | 5.9 GB | 3.7 GB |
| Plain sentences heard as written | all, both languages | all in English; about 1 word in 40 off in Turkish |
| Turkish digits | one year read wrongly | garbled |
| Load | 95 s with its compile step | 18 s |
| Output | 48 kHz | 24 kHz |

The owner listened and chose VoxCPM2 (click). Listening for word times took 0.3 s a clip. Met on the way: the
newest PyTorch wheel does not start on every host's GPU driver (it fell back to the CPU on one): the image keeps
the PyTorch of its base image; a compile step needs a C compiler; the published `voxcpm` takes no `seed`.

**Built, offline** (the pattern of 2.4: TypeScript verified with stand-ins, Python unit-tested, the image and the
endpoint verified live only):

- `worker-voice/`: the contract (one line, a voice, an optional language, a seed), the handler, the image with
  both models inside it. The speech returns in the job's answer as MP3; nothing is uploaded, the two scratch
  files are removed on every path, nothing of a line is logged, FlashBoot is off. A line that begins with a
  parenthesis is refused: that is how this model is told to invent a voice.
- Two voices, each with an English and a Turkish reference clip (made by the model's own voice design).
- `RunpodTts` asks once per line, and once more by itself (another seed) when under half the line was heard as
  written; after a job is bought nothing is bought again by a retry.
- `alignWords` lays the script's words over the heard ones: a word heard as written keeps its time, the rest
  share the time between their neighbours. Captions keep showing the script.
- The script's language is worked out from the whole script (Turkish, English, or unsaid), only for runs on the
  studio's own voice: an earlier run's request and cache keys are unchanged, and `compat.test.ts` passes.
- New runs use the voice endpoint once `RUNPOD_VOICE_ENDPOINT` is set (`npm run voice:deploy`); until then, and
  for every earlier run, ElevenLabs. §5.2's purge waits for the live check.
- Estimates: `(1.5 + 0.02 × characters) s × rate` a line, plus 40 s once a run for the worker's start. The 40 s
  is a guess (the benchmark measured the load only with the compile step, which the worker leaves off).

**Unverified until the live check:** the image build; that the models load without network; the load time and
speed without the compile step; Whisper on the GPU in that image; the size of an answer with speech in it; a
real run's captions.

**Known limits:** digits are read as the voice reads them; languages other than Turkish and English speak from
the English clip; a customer cannot bring a voice.

### 9.4 Worker privacy (2026-10-09, before its live check)

- **After every job, on every path,** the picture and clip worker has ComfyUI drop its prompt history and its
  nodes' cached pictures and latents (`comfy.forget()`: `/history` cleared, `/free` with the weights kept), and
  empties ComfyUI's scratch folder. A ComfyUI that cannot be reached for this does not lose the job; the worker
  says so in one line that carries the job's id and nothing of its content.
- **FlashBoot is off** on all three endpoints: no worker state is kept across a stop. What that costs in start
  time is measured by the live check.
- **The workers' uploads expire after a day** (`R2.expireAfter("flowchain/", 1)`, set by `runpod:deploy`; a
  refusal is a warning, not a failed deploy). The voice worker uploads nothing.
- Nothing a worker prints carries a prompt, a line or a file name (tests read the handlers' output).
- **Not done:** the volume is not mounted read-only (the platform offers no such mount for a serverless
  worker); the worker writes under it only in `fetch-models`. GPU memory is not zeroed between jobs: the next
  job's own tensors overwrite it, and no other customer's container shares the process.
- **Unverified until the live check:** that this ComfyUI version honours `free_memory` without unloading the
  weights; that R2 accepts the lifecycle call with these keys.

### 9.5 Live check, first day (2026-10-09)

- **The voice image built and runs** on a pod: PyTorch sees the GPU, both models load with no network in 22 s
  (speaker) and 0.6 s (listener).
- **It could not speak:** pip had quietly installed an older `voxcpm` (the newest one's demo page and RunPod's
  SDK want different versions of one small package, and the resolver stepped back until they agreed). The two
  are now installed in two steps, the library is pinned, and the build ends with a check that it can speak from
  a reference clip. The image moved to PyTorch for CUDA 12.8, and the endpoint asks for hosts with it.
- **FlashBoot:** RunPod creates an endpoint with it on whatever is asked, and takes "off" only as a change.
  `upsert` now sends that change after a create.
- **The bucket's expiry rule was refused** (HTTP 403: the workers' key may read and write objects, not change
  the bucket). The pipeline now removes each upload itself as soon as it has its own copy (`remove()` on a
  provider's output, by the job's own key); the rule is still tried, and its refusal is a note with the words
  for setting it by hand. Left in the bucket only: what a run uploaded and never fetched.
- **Open:** the voice endpoint took no job in its first ten minutes (hosts were probably still pulling the
  image); to be confirmed from a worker's log.

### 9.6 Live check: the voice works; one hardening step was too dear (2026-10-09)

Run `20261009-175401-f4a4f2` (`npm run smoke:runpod`: 4 scenes, modes 1,2,1,1, 21.6 s) finished on the first
attempt, spoken by the studio's own voice.

- **Voice: $0.014 for the four lines** ($0.0102 for the first, which paid for the worker loading its models;
  $0.0012–0.0013 for each of the others). The same lines on ElevenLabs cost about $0.11. Before that, three
  test lines directly on the endpoint: a first line 313 s after it was asked for (four minutes of a new host
  pulling the image, then 42 s billed), then 5–7 s a line. So the unexplained wait of §9.5 was the image pull.
- **Word times** come out in order, inside each clip, for every word of the script, in English and Turkish; a
  year written in digits takes the span of the words it was read as.
- Price defaults set from this: 3 s a line plus 0.02 s a character, 40 s once a run.
- **The whole video cost $0.27, where about $0.13 was expected.** Keyframes took 54–66 s each (6 s before) and
  clips $0.055 each (about $0.022 before). Cause: `comfy.forget()` asked ComfyUI to free its memory after every
  job, and ComfyUI answered by dropping the loaded weights too, so every job loaded its model again. §9.4's
  caveat was right to be one.
- **Ruling:** the worker clears ComfyUI's prompt history after every job and no longer asks it to free its
  cache. What a node cached from one job cannot be read by the next (the handler is ComfyUI's only client and
  returns a job's own files only) and is replaced by the next prompt. Cost if wrong: a customer's last
  intermediate picture stays in that worker's memory until its next job or its stop, readable by nobody else.
- **Still to measure** after that fix: a video's cost again, and what FlashBoot being off adds to a start.

### 9.7 ElevenLabs purge (2026-10-09)

The owner chose to remove it once the live run had been spoken by the studio's own voice (click).

- `src/providers/elevenlabs.ts`, `ELEVENLABS_*` and its `doctor` check are gone. A new run's voice is the voice
  endpoint or nothing: `newRunVoice` says to run `npm run voice:deploy`.
- A run whose `models.tts` is not `runpod:…` needs no key and re-renders; its `speak` refuses with one sentence
  and is never retried. `ttsPer1kChars` stays as data for such runs' estimates. `RETIRED_KEYS` gained the three
  `ELEVENLABS_*` names, so an owner's `.env` that still has them hands them to no process.
- The studio's readiness check asks for `RUNPOD_VOICE_ENDPOINT` in place of the two ElevenLabs settings.
- With this, the pipeline talks to three services: Gemini (the script), RunPod (pictures, clips, voice) and R2.

### 9.8 Live check, second run: the cost after the fix (2026-10-09)

Run `20261009-185805-4f8fca` (4 scenes, modes 1,1,1,1, 21.4 s) on the fixed worker image, spoken by the
studio's own voice, with ElevenLabs no longer in the code.

| | This run | The same shape before today (2.4 §16) |
|---|---|---|
| Script | $0.011 (asked twice: the first answer failed its check) | $0.006 |
| Voice, 4 lines | $0.019 ($0.0139 the first, about $0.0016 each after) | $0.105 |
| Portrait and 4 keyframes | $0.038 | $0.025 |
| 4 clips | $0.142 ($0.072 the first, about $0.023 each after) | $0.135 |
| **Total** | **$0.21** | **$0.27** |

- Keyframes and clips on a warm worker cost what they did before the hardening ($0.0018 and $0.023): clearing
  ComfyUI's history alone does not unload anything.
- The first keyframe took about a minute where it took 17 s before: the keyframe worker had stopped while the
  script and the voice were made (30 s idle) and, with FlashBoot off, loaded its checkpoint again. That is what
  FlashBoot being off costs here: about one cent a video.
- Nothing this run uploaded was left in the bucket afterwards (`remove()`); 24 files from runs before today
  are still there.
- These are ledger figures from measured execution time, as in 2.4: not compared with an invoice.

**Phase 5 at this point:** done and live-checked: fal purge, names, own database and sign-in (local and stack
only), own voice, ElevenLabs purge, worker hardening. Not started: the picture and clip benchmark and model
upgrade (§6.2, §6.3). Not decided: Gemini (D3).

### 9.9 Benchmark: clips, hardware and pictures (2026-10-09)

Temporary pods, the production worker image and graph for clips (Wan 2.2 I2V A14B fp8, 4 steps, RIFE ×2), one
input keyframe. Seconds are wall time of one clip with the models already loaded, unless said.

| GPU | 480×832, 65 frames | 720×1280, 65 frames | 720×1280, 81 frames | Peak memory |
|---|---|---|---|---|
| RTX 4090 (24 GB) | 63 s (with the load) | 157 s | 217 s | 23.6 GB: at the card's limit |
| H100 (80 GB) | 29 s | 80 s | 109 s | 47 GB |

Cost of one 65-frame clip at RunPod's serverless rates:

| | 480p | 720p |
|---|---|---|
| RTX 4090 ($0.000306/s) | about $0.022 (the live runs' own figure) | $0.048 |
| H100 ($0.00133/s) | $0.038 | $0.107 |

- **An H100 is about twice as fast and costs 4.35 times as much: a clip costs about twice what it costs on the
  4090.** The A100 ($0.000756/s) would have to make a 720p clip in 63 s to match the 4090; the H100 itself
  needs 80 s. Neither is used. (The A100 pod never finished fetching its image in 26 minutes and was stopped
  unmeasured; the RTX 5090 pod likewise. Both conclusions about them rest on the H100's numbers and the rates.)
- **720p fits on the 24 GB card** and costs 2.2 times a 480p clip there: about +$0.10 on a four-clip video.
- Flaw in the first clip run, kept out of the table: its repeated configurations were answered from ComfyUI's
  cache in 10 and 22 s.

**Pictures** (RTX 4090, 1088×1920, the pipeline's own prompts from run `20261009-185805-4f8fca`):

| | FLUX.2 klein 4B | Z-Image Turbo | Today (SDXL + IP-Adapter, from the live runs) |
|---|---|---|---|
| One picture | 2.8 s at the final size | out of memory at this size on 24 GB | about 6 s, in two passes |
| With a reference portrait | 4.5 s | not offered by the model | included |
| Memory | 19.7 GB | over 23 GB | — |
| Load | 51 s | 50 s | — |
| Licence | Apache 2.0 | Apache 2.0 | OpenRAIL++-M |

- **Today's pictures do not follow the scene.** Set beside each other, both SDXL keyframes of that run are the
  same waist-up portrait by a window, where the script asked for a woman running up spiral stairs and for her
  striking a match in the lantern room; the tower shot came out as a portrait too. The reference conditioning
  that keeps the face also keeps the pose. This was not seen before because nobody had laid a run's prompts
  beside its pictures.
- **klein follows the scene** (stairs, canister, lens, match, the tower from below) and makes the anime and 3D
  looks from the one model, where today each look has a checkpoint of its own.
- **Identity with klein is not settled.** With the portrait and the words "the woman from the reference image"
  in place of her description, the coat changed colour and the face was not held. The run that would settle it
  (portrait and description together, several scenes) was not made.
- Z-Image Turbo is out for this worker: it does not fit the card at the pipeline's size and takes no reference.

**Spend:** this section about $3.5, the voice benchmark and its diagnosis $0.44: $3.96 of the $5 (D2). About
$1.3 of it bought nothing: two pods that never got past fetching an image, and two runs lost to my scripts'
mistakes (a missing `git`, a download cut off with no retry).

**What this changes in §6:** §6.2: FLUX.2 klein 4B is the candidate; identity is the open question. §6.3: 720p
on the RTX 4090 is affordable (a four-clip video at about $0.31). §6.5 stands, now with measurements.

### 9.10 Identity with FLUX.2 klein (2026-10-09)

One RTX 4090 pod, $0.04. Four scenes of one character (running up stairs, striking a match, standing on the
gallery in rain, a close-up), each made three ways at 1088×1920, same seed:

- **the description alone:** the scene is followed; the face is a different woman from scene to scene;
- **a portrait made by klein itself (1024², 1.3 s) plus the description:** the scene is followed as well, and
  the face, the parting and the braid match the portrait in the three scenes where the face is large enough to
  judge (match, gallery, close-up); 4.5 s a picture;
- **today's SDXL portrait plus the description:** the same holds, with that softer face.

Judged by eye from one character and one seed, by the one who ran it; the owner decides from the sheet
(`.superpowers/model-test/ident-sheet.jpg`). What was wrong in §9.9's test was leaving the description out.

**Owner's decisions (clicks):** settle identity before switching (this section); clips are offered at both
480p and 720p.

### 9.11 Picture worker and the 720p choice, before their live check (2026-10-09)

**Built, offline** (TypeScript with stand-ins, Python unit-tested; the image, the weights and a run live only):

- `worker-picture/`: FLUX.2 klein 4B through `diffusers==0.41.0`, the same request and answer as the worker
  before it (workflow `keyframe-klein@1`), a portrait as the reference. Its weights are fetched to the network
  volume by its own `fetch-models` (one pinned revision of the model; the four big files checked by size and
  SHA-256 before a marker is written), so the image stays small. The picture is uploaded as before and removed
  by the pipeline once fetched; scratch files are removed on every path; nothing of a prompt is printed.
- It is not a ComfyUI graph: the benchmark measured it through `diffusers`, and that is what was built. The
  clip worker stays on ComfyUI.
- New runs: `runpod:<endpoint>/keyframe-klein@1`, image profile `runpod-klein@1` (6 s a picture, 3 s the
  portrait, 60 s once for a stopped worker), a reference stage as before. `takesReference()` replaces the three
  checks for the SDXL profile's name.
- **A run made on the SDXL worker** keeps its model id; the keyframe endpoint now runs another worker, which
  refuses that workflow. Such a run loads and re-renders; a picture of it cannot be made again. Ruling: accepted
  (two test runs and the showcases, all finished) — it costs a reroll on an old run.
- Deploy: a second template (`flowchain-picture`) for the keyframe endpoint, `minCudaVersion` 12.8 there, the
  volume grown to 110 GB, the picture image checked in the registry like the other, a third image job in the
  workflow.
- **720p clips**: the worker's contract takes 720×1280 and 1280×720 beside the 480p sizes (same graph, same
  workflow id); video profile `wan22-720p@1` (2.5 s a frame); `--clips 480p|720p` on `run`, "Standard / HD
  (720p)" in the studio's form; the height is in a 720p clip's cache key and in no 480p one's. A receipt's
  `clipHeight` now comes from the run's profile.

**Unverified until the live check:** the image build (that `diffusers` 0.41.0 has the pipeline, checked by the
build itself); `snapshot_download` to the volume; load time from the volume; a picture's real seconds; that a
keyframe follows its scene and keeps the face in a whole run; a 720p clip through the endpoint within its
timeout.


### 9.12 Live check: the picture worker and 720p clips (2026-10-09)

Two paid videos on the three endpoints, same topic, four scenes, all four as clips.

| | Run `…212102-c7ebcf` (480p) | Run `…214323-85cfa6` (720p) |
|---|---|---|
| Script | $0.0055 | $0.0055 |
| Portrait | $0.0145 | $0.0197 |
| Voice, four lines | $0.0184 | $0.0166 |
| Pictures, four | $0.0264 (0.0202, then ≈ 0.002 each) | $0.0203 (0.0154, then 0.0013–0.0018) |
| Clips, four | $0.1279 (0.0598, then ≈ 0.023 each) | $0.2243 (0.0826, then 0.043–0.052) |
| **Total** | **$0.19** | **$0.29** (estimated before: $0.32) |
| Wall time | 12 min | 27 min |

**What held:** the images built; the model reached the volume and loads from it (a stopped worker's first
picture: about 60 s, 1.5–2 cents); a picture with the portrait takes ≈ 6 s of GPU, without it ≈ 4 s; the face,
hair and clothes are the same person in every scene she is in, doing what the scene says; 720p clips came back
at 720×1280, each within the endpoint's limit (≈ 170 s once warm); nothing was left in the bucket after either
run. The price defaults of §9.11 stand.

**What was wrong, and was changed.** The new model does what its prompt says, where the one before it mostly
did not, and three habits of the prompts showed at once in the first run: the same woman stood, hands clasped,
beside a candle in all four pictures, two of which were meant to be an empty staircase and an empty lantern room.

1. **Every scene was told about the character, and given her portrait.** The script now says, scene by scene,
   whether a recurring character is in frame (`showsCharacter`, required of the script model, optional when
   stored). A scene that says no gets neither the description (picture and motion prompt) nor the portrait; a
   script whose every scene says no has no portrait stage. A script without the field is read as before, so
   earlier runs keep their prompts and their hashes.
2. **The portrait carried a pose and props.** On this worker it is asked for first and bare (arms at the
   sides, empty hands, nothing else in frame), with the look after it. The second run's portrait is a plain
   studio figure, and the two character scenes no longer copy its stance.
3. **The preset's own words were drawn.** `cinematic_history` opened every picture prompt with "natural window
   and candle light, period-accurate costumes and props": the second run had candles on a cliff edge and a
   stranger in costume on an empty gallery. It now reads "natural light, period-accurate details". The four
   pictures of the second run were made again directly with that wording (4 jobs, $0.02): no candles, no
   stranger, the character unchanged. The second run's own video still has the earlier pictures.

**Also changed:** the portrait's estimate now counts a start of its own. The voice is made between the portrait
and the first picture, the picture worker has stopped by then (30 s idle), and both runs paid two starts. The
plan had shown the portrait at $0.0009 against $0.0145–0.0197 spent.

**Rulings and parked:**

- A run made today with `cinematic_history` or on the klein profile has other prompt text now, so a `resume` or
  a reroll of it would make its pictures and clips again. Ruling: accepted (two test runs; nothing is deployed;
  `rerender` is unaffected).
- `dark_fantasy` still names candlelight in its prefix: it is that preset's look, and is left. The other
  presets' prefixes name no object. Parked: a look at each preset's pictures on this model before launch.
- Two starts of the picture worker per run (≈ 2 cents) could become one by making the portrait after the
  voice. Parked: it means moving a stage in the plan, for a cent or two.
- A 720p video took 27 minutes, 14 of them waiting for the clip worker's first job (billed for 270 s of it).
  Parked: the studio's form says "HD (720p)" without saying it takes about twice as long.
- The run's model id for clips reads `clip-wan22-480p@1` at 720p too: the workflow is the same and the size is
  in the profile (§9.11). Left.

Spent on this check: $0.19 + $0.29 + $0.02 = $0.50 of the $1 approved.

### 9.13 One start for pictures, a clips-only worker, a smaller volume (2026-10-09, before its live check)

The owner asked for five changes. What was done with each, and why:

1. **Wan 2.2 → "Wan 2.7": not done, and Wan 2.2 is not removed.** There are no Wan 2.7 weights to run. The
   publisher's model list (Hugging Face API, `author=Wan-AI`, read 2026-10-09) ends at the Wan 2.2 family
   (the newest entries are Wan2.2-Animate-2 and Wan-Dancer, neither an image-to-video model for this use), and
   the repackaged ComfyUI files stop at 2.2 too; Wan 2.5 to 2.7 are sold through hosted APIs only. Moving to
   one would undo this phase (a second provider, prompts and pictures sent out, about $0.10 a second of video
   against about $0.006 here). §6.3 stands: Wan 2.2 I2V A14B is the newest Wan with open weights. Deleting it
   from the volume would have left the studio unable to make a clip.
2. **Pictures in one session.** The portrait is now made after the voice and straight before the keyframes
   (`script → tts → silence → modes → reference → keyframes → clips`), so the picture worker is started once a
   run (§9.12 measured two starts, about 2 cents). The order asked for was pictures before the voice; that one
   is not possible without buying pictures blind: which scenes get a picture is decided by the modes stage, from
   the lengths of the spoken lines and the budget (2.2 spec §4.1), and the second confirmation prices the media
   from them. Moving the portrait gets the same single start and keeps both. The second confirmation ("Media
   plan") now comes before the first picture bought, the portrait included. The portrait's estimate is its 3 s
   again; the run's one start stays counted with the first picture.
3. **The earlier picture weights leave the volume.** The six SDXL-era files (24 GB) are out of
   `workers/models.json`, and the clip worker's `fetch-models` now ends by removing, from the folders that are
   its own, every file the list does not name (`models.purge`): only after everything listed is present and
   checked, never in a sub-folder, never in the picture worker's folder. With them went what could only run on
   them: the SDXL graph, its presets, the `keyframe` task of the clip worker's contract and handler, and the
   IP-Adapter node in its image. This settles §9.11's ruling for good: a run made on the SDXL worker loads and
   re-renders, and a picture of it cannot be made again.
4. **Text encoder and VAE in the clip image.** `umt5_xxl_fp8_e4m3fn_scaled.safetensors` (6.7 GB) and
   `wan_2.1_vae.safetensors` are downloaded and checked by SHA-256 in the Dockerfile, into ComfyUI's own model
   folders, and are off the volume's list (so item 3's removal takes the volume's copies too: 7 GB more). The
   two 14 GB experts and their LoRAs stay on the volume. The clip template's disk goes from 30 to 40 GB.
   **Not measured:** that this halves a start. A worker's start also loads 14 GB from the volume, twice; the
   image is 7 GB larger for a host that has never held it.
5. **`idleTimeout` 30 → 90 s: not changed; the owner is asked.** RunPod bills a worker until it has stopped,
   idle seconds included. Sixty more seconds on two endpoints is about 3.7 cents a video (some 19% of a 480p
   video), and after item 2 no stage leaves a gap that long between two jobs of the same endpoint (clips follow
   each other within seconds). It would cost more than the starts it was meant to save.

The volume stays 110 GB (a volume cannot shrink): it will hold about 47 GB. Making a smaller one means a new
volume and downloading the models again. Parked.

**Unverified until the live check:** the clip image's build with the two files inside (size on the build
machine; that ComfyUI finds them where they are); the removal on the real volume; a start's real seconds
before and after; one start of the picture worker in a whole run.

### 9.14 Live check of §9.13 (2026-10-10)

The owner's answers: stay on Wan 2.2; keep `idleTimeout` at 30 s; push, deploy and make one paid video.

- **Image:** the clip image built with the text encoder and the VAE inside (15 minutes on the hosted builder).
- **Deploy:** `fetch-models` on the clip endpoint found its four files and removed eight from the volume: the
  six SDXL-era files, and the volume's copies of the text encoder and the VAE. The picture model was untouched
  ("already present 4"). The deploy took 50 minutes, nearly all of it a host fetching the new image.
- **Run `20261010-002332-b4284b`** (480p, four clips): **$0.147**, against $0.19 for the same request the day
  before; 9 minutes against 12.

| | Before (§9.12) | After |
|---|---|---|
| Portrait | $0.0145 | $0.0142 (it pays the one start now) |
| Pictures, four | $0.0264 | $0.0060 (first: $0.0012) |
| Clips, four | $0.1279 (first $0.0598) | $0.1045 (first $0.0494) |

**What held:** the picture worker started once; ComfyUI found the text encoder and VAE in the image (four
clips made); the scenes without the character are empty of people and of candles, and the two with her show the
portrait's face doing what the scene says.

**What did not:** a start of the clip worker is not halved. The first clip's cost over a warm one fell from
about 3.7 to about 3.1 cents (roughly 120 s to 100 s): the two 14 GB experts still come from the volume. The
default of 90 s for that start stands. Part of the lower clip total is shorter lines in this script.

Spent: $0.15 for the video; the deploy's `fetch-models` jobs ran seconds.
