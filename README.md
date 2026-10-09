# Flow-Chain-AI — CLI and Studio

Turns a topic into a captioned short video. Audio drives timing: the voiceover is generated and
silence-trimmed first, then every visual is fitted to it frame-exactly. The final video is rendered with
Remotion (React): word-by-word captions, Ken Burns stills, transitions at cuts and ducked background music.

Design: `docs/superpowers/specs/2026-10-02-phase1-cli-poc-design.md` (pipeline),
`docs/superpowers/specs/2026-10-03-phase2.1-remotion-render-engine-design.md` (render engine),
`docs/superpowers/specs/2026-10-04-phase2.2-content-intelligence-design.md` (modes, transitions, style presets),
`docs/superpowers/specs/2026-10-05-phase2.3-retention-brand-design.md` (hook, sound effects, brand kit, clip lengths),
`docs/superpowers/specs/2026-10-05-phase2.4-runpod-providers-design.md` (RunPod providers)
and `docs/superpowers/specs/2026-10-06-phase3.1-web-ui-player-design.md` (the studio web app).

## Setup

1. `brew install ffmpeg` (≥ 6 with libx264), Node ≥ 22.12
2. `npm install`
3. `cp .env.example .env` and fill in `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
4. Set up the GPU endpoints that make the pictures and clips: see "The GPU worker" below (`npm run runpod:deploy`)
5. `npm run flowchain -- doctor` — every line must show ✓ (the first run downloads Remotion's headless
   Chrome, ≈ 100 MB, once)

## Usage

```bash
npm run flowchain -- run --topic "The last lighthouse keeper" --scenes 4            # auto modes, Gemini picks the style
npm run flowchain -- run --topic "…" --style cyberpunk --budget 2                   # a fixed style preset and budget
npm run flowchain -- run --topic "…" --modes 1,2,1,1 --aspect 16:9 --bgm music.mp3 # hybrid, modes fixed by hand
npm run flowchain -- run --topic "…" --caption-style mrbeast --transition zoom      # override the preset's look
npm run flowchain -- run --topic "…" --brand assets/brand/example                  # watermark, brand font and colours
npm run flowchain -- run --topic "…" --hook "3 minutes to midnight" --seed 42      # own hook title, fixed seed
npm run flowchain -- status <runId>
npm run flowchain -- resume <runId> [--from clips]
npm run flowchain -- reroll <runId> --scene 2 --stage clips    # later chained clips follow
npm run flowchain -- rerender <runId> --caption-style minimalist --transition dissolve   # free
npm run flowchain -- rerender <runId> --no-hook --sfx-gain 0.4 --no-brand                # free
npm run flowchain -- rerender <runId> --hook-on --sfx                                     # free
```

Mode 1 = image-to-video, each continuing clip starting from the last frame viewers see of the
previous (fitted) clip. Continue seams are always hard cuts.
Mode 2 = a still picture animated with a Ken Burns camera move at render time (no clip is generated).

`--mode auto` (the default) lets Gemini rate each scene's action level: high → Mode 1, low → Mode 2, medium →
Mode 1 while the run fits the budget (`--budget`, frozen with the run), otherwise Mode 2, largest saving first.
`--mode 1|2` or `--modes` fix the modes by hand. `status` shows each scene's mode and why.

Style presets (`--style`, default: Gemini picks one for the topic): `cinematic_history`, `anime`, `cyberpunk`,
`dark_fantasy`, `photorealistic_8k`, `3d_render`. A preset wraps every image and motion prompt and brings its own
caption look.

Caption styles: `preset` (default: the style preset's look), `hormozi`, `mrbeast`, `minimalist`. Transitions at
cuts: `auto` (default: the one Gemini suggests for each cut), `cut`, `fade`, `dissolve`, `blur`, `zoom`, `glitch`.
`--bgm-gain` sets the music level outside speech (default 0.35); under speech it ducks to 40 % of that.

The first 3 s open with a hook: a snap zoom, a big title Gemini writes (or `--hook "…"`) and an impact sound
(`--no-hook` turns it off, and `rerender --hook-on` brings a removed hook back). Cuts get sound effects: a
whoosh into `zoom` and `blur`, a pop on `glitch` and hard cuts, nothing on `fade` and `dissolve` (`--no-sfx`,
`--sfx-gain`; `rerender --sfx` turns them back on). The sounds are bundled in `assets/sfx` (`npm run make:sfx`
regenerates them).

A brand kit is a folder with `brand.json` (see `assets/brand/example`): a logo watermarked at a corner, and an
optional font, text and accent colours and character bible. `--brand <dir>` copies it into the run;
`--characters "…"` sets the character bible directly. Every keyframe of a run shares one seed (`--seed`).

Each run lives in `runs/<runId>/`: `manifest.json` (state, cache keys, cost ledger), `final.mp4`,
`chain.png` (per scene: first frame of the raw clip and last frame of the fitted clip, or the keyframe for
Mode 2 — use it to judge continuity at each seam), plus intermediates.

## Costs

Estimates come from the price table in `src/config.ts` (override with `prices.json`). A run asks for
confirmation when the estimate exceeds `FLOWCHAIN_BUDGET_USD` (default $3); rerolls ask unless you give `--budget`; `--yes` skips.
For `--mode auto` runs, `--budget` (or `FLOWCHAIN_BUDGET_USD`) and the price table are frozen with the run for
the mode rules; a later `--budget` only changes when to ask. `resume --from <stage>` re-runs, and re-buys,
that stage and every later one (so `--from modes` re-buys every keyframe and clip). On runs with a seed,
`resume --from keyframes` (or an earlier stage) reproduces the same keyframes because the seed is fixed;
`reroll --scene N --stage keyframes` gets new ones. Narration is capped at 16 words per scene, and a clip is
only as long as its narration needs (the fit step stretches it by up to a quarter), so a typical 4-scene
Mode 1 run is about $0.30. `rerender` never calls a paid API. `npm run smoke` runs a real 3-scene all-Mode-1
video with `--shots cut,continue,continue`, so two real continuity seams are always exercised. `--shots` is a testing override; without it the LLM decides. `npm run
smoke:auto` runs a real 4-scene `--mode auto --style cyberpunk` video with the example music bed, and `npm run
smoke:brand` a 4-scene `--style anime` video with the example brand kit.

Rendering a 16 s 1080×1920 video takes about 1.5 minutes on Apple Silicon (`--render-concurrency` tunes it).

## The GPU worker (keyframes and clips)

Keyframes (SDXL with IP-Adapter character references) and clips (Wan 2.2 image-to-video) run on your own
RunPod Serverless endpoints: roughly $0.20–0.35 per 4-scene video. This is the only way the studio makes
pictures. Runs made earlier on hosted models (fal) still load and re-render for free, but they can no longer be
resumed or rerolled: `resume` and `reroll` say so and buy nothing.

One-time setup (accounts and keys only):

1. RunPod: create an API key → `RUNPOD_API_KEY` in `.env`.
2. Cloudflare R2: create a bucket and an S3 API token with read/write on it → `R2_ACCOUNT_ID`, `R2_BUCKET`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in `.env`.
3. Push this repo to GitHub: the `worker-image` Action builds `ghcr.io/<owner>/flowchain-worker`. Make that
   package public (GitHub → Packages → flowchain-worker → Package settings → Change visibility).
4. `npm run runpod:deploy` creates the network volume, template and two endpoints, downloads the model weights
   onto the volume and writes `RUNPOD_KEYFRAME_ENDPOINT` / `RUNPOD_CLIP_ENDPOINT` into `.env`. It shows what it
   will create, the monthly volume cost (≈ $5.60 for 80 GB) and the one-time model download it runs on the
   endpoints' GPUs (≈ $1–2), and asks first; re-running it updates in place. It uses the image tag built from the
   current `workers/` folder and stops if that image is not public on GHCR. `RUNPOD_WORKER_IMAGE` deploys another
   image instead, `RUNPOD_DATACENTER` picks another data centre (default `EU-RO-1`), and `--yes` skips the question.

Then `npm run flowchain -- doctor`. `npm run smoke:runpod` makes a real 4-scene video and is a paid run.

Runs with characters get one generated reference portrait (or a brand kit's `reference` image) that every keyframe
is conditioned on; `reroll <runId> --stage reference --scene 1` generates a new portrait (keyframes are then
redone from it). Clips are 480p (upscaled to the output size) with frame interpolation to 32 fps. GPU time is
charged per job from RunPod's measured execution time; cold starts and idle time are not attributed per job.

The model stack is licensed for commercial use (SDXL / RealVisXL / Animagine under CreativeML Open RAIL++-M,
IP-Adapter Apache 2.0, Wan 2.2 Apache 2.0). Open RAIL++-M requires its use restrictions to be passed on in your
customer terms.

## Studio (web app)

`npm run web` starts the studio at <http://127.0.0.1:3131>: a local, single-user front end to the same runs the
CLI makes (everything in `runs/` shows up, and anything made in the studio can be resumed from the terminal).

1. **New video** buys only the script (about $0.006) and opens a **draft**: the real Remotion composition in the
   browser with placeholder pictures, estimated timing and no voice, but the real captions, hook, transitions,
   brand, music and sound effects.
2. On the draft, set each scene to **Auto, Clip or Still**; the price updates. **Generate video** shows the
   estimate on the button, and that amount is a cap on what the job spends in total (`--cap`): if what the job
   has already spent plus what is still planned ever exceeds it, the run stops and asks again instead of
   spending more.
3. A finished run plays with its real media. Caption style, transitions, hook, sound effects, music level and
   brand preview live as you change them; **Apply and re-render** is free. Each scene can get a new voice take,
   picture or clip, priced before you confirm and capped at that price in the same way. Generating and
   regenerating a scene first save a look you changed but have not saved, so the video is made with the look
   the preview shows; **Save this look** keeps a look on a run that is not finished yet.
4. **Brand kits** creates kits by upload (logo, optional font, colours, characters, portrait) into `brand-kits/`;
   music can be uploaded in the new-video form (`uploads/music/`). Both folders are git-ignored. Upload limits:
   logo 2 MB, font 5 MB, portrait 6 MB, music an MP3 of up to 20 MB.

The studio has no login. It listens on `127.0.0.1` only, answers only requests addressed to `127.0.0.1` or
`localhost`, and refuses any write that does not come from its own pages. API keys stay in `.env`, and only
the CLI uses their values: the studio reads `.env` only to see which names are set and what the default
provider and budget are, and the browser never receives a value. Jobs are the CLI itself, started detached, so
a job keeps running if the web server restarts; at most two run at once. The preview is not frame-exact (the
rendered MP4 is), and draft timings are estimates.

The studio's own settings are not read from `.env`: set `STUDIO_MAX_JOBS` (how many jobs may run at once) and
`RUNS_DIR` (another runs folder) in the environment the studio starts in, for example
`STUDIO_MAX_JOBS=3 npm run web`.

Remotion is free for individuals and companies of up to three people; larger companies need its company licence.

The studio uses these CLI commands, which also work on their own:

| Command | Does |
|---|---|
| `run --draft` | buys only the script and stops; `resume` continues |
| `run --pin-modes auto,1,2` | pins scenes of an auto run to clip (1) or still (2) |
| `draft-modes <runId> --modes auto,1,2` | changes the pins while only the script is bought |
| `plan <runId> [--reroll 2:clips] [--modes …] [--json]` | what continuing would do and cost, without doing it |
| `look <runId> …` | stores a new look without rendering (takes `rerender`'s look options, not `--render-concurrency`; works on a draft) |
| `status <runId> --json` | the status as JSON |
| `reroll … --budget <usd>` | a reroll that spends up to an amount without asking |
| `resume … --cap <usd>`, `reroll … --cap <usd>` | stops the command when what it has spent plus what is still planned would exceed the amount |

## Studio on a server

One server runs the studio over HTTPS — for you alone behind one login, or with accounts (next section): a proxy (Caddy), the web app, **one
worker** that takes jobs from a queue (Redis) and runs the CLI for each, and Redis. Jobs wait their turn: two
generations run at once by default, the rest show their place in line. A job is never retried on its own — a
failed or interrupted run waits for you to press Resume, so nothing is bought twice.

Once, by hand: rent a server (4 vCPU, 8 GB RAM, Ubuntu or Debian, your ssh key for `root`), point a DNS name
at it, then `cp deploy/server.env.example deploy/server.env` and fill in `SERVER_HOST` and `STUDIO_HOST`. The
provider keys are taken from your `.env`.

| Command | Does |
|---|---|
| `npm run server:setup` | installs Docker if missing, creates `/opt/flowchain`, writes the settings and keys, makes the login password (shown once), turns on the nightly backup if `BACKUP_BUCKET` is set, then deploys |
| `npm run server:deploy` | copies the last commit to the server, builds, restarts and waits until the studio answers; a running job gets up to 30 minutes to finish first |
| `npm run server:backup` | copies runs, brand kits and uploads to the backup bucket now |

`npm run server:setup -- --new-password` replaces the login. Run setup again after changing a key in `.env` or
a setting in `deploy/server.env`. Connect to the server once by hand first (`ssh root@<server>`) and compare the
host key it shows with the one your provider lists: the scripts trust the key they see on first contact. If a
deploy is cut off (the laptop sleeps, the connection drops), run it again; it picks up where the server is.

On the server the web app holds no provider keys and never runs the CLI; only the worker does. The data is in
`/opt/flowchain/data` (`runs/`, `brand-kits/`, `uploads/`): a run made there is an ordinary run folder. The
backup copies new and changed files and never deletes from the bucket. How many jobs run at once is
`WORKER_CONCURRENCY` in `deploy/server.env` there (`STUDIO_MAX_JOBS` applies to `npm run web` only). If the worker is down, the studio says
so and refuses to start paid work instead of queueing it.

Locally nothing changes: without `REDIS_URL`, `npm run web` starts jobs itself as before. To try the queue on
your machine: `redis-server` in one terminal, then `REDIS_URL=redis://127.0.0.1:6379 npm run worker` and
`REDIS_URL=redis://127.0.0.1:6379 npm run web`.

## Accounts, credit and storage

With `STUDIO_ACCOUNTS=1` in `deploy/server.env` the studio has accounts, kept in a database of its own that
runs on the same server (Postgres, in the stack). Without it, nothing below applies and the studio is the
single-user app described above.

- **Signing in.** Anyone can create an account with an email address and a password, or with Google. Each user
  sees only their own videos, brand kits and music: everything of anyone else's answers "not found". There is
  no proxy login and no password from setup in this mode: you sign up like everyone else.
- **Credit.** Every account has a balance in USD, starting at 0. A generation or a regenerated scene holds the
  amount you approve on its button, the worker runs it capped at that amount, and what it did not spend comes
  back; a draft holds $0.02 for its script (about $0.006). The account page shows the balance and every
  movement. With too little credit the button says so and nothing starts. You add credit with
  `npm run studio:grant -- --email <address> --usd 5` (`--usd -2` takes some back; it prints which studio it
  acted on).
- **What is charged.** What the run's own record says was spent, plus anything that was sent to a provider and
  not collected: a clip, picture, narration or script request that was on its way when the job was stopped is
  charged, because the provider bills it either way. This errs on the side of charging: a request the provider
  in the end never ran, or one that cost less than expected, stays charged at the expected price. A provider
  that bills by measured time can also come out slightly above a cap; the real amount is charged, and a
  balance below zero has to be topped up before anything paid can start.
- **Storage.** With `STUDIO_BUCKET` set (a private R2 bucket of its own), every run is copied to the bucket
  after each job and uploads are kept there; the server's disk is a cache. A run untouched for
  `STUDIO_CACHE_DAYS` (14) is removed from the disk and comes back when its owner opens it. A file the disk
  lacks is served by a link to the bucket that is valid for five minutes.
- **Limits.** One account may have two long jobs waiting or working (`STUDIO_USER_JOBS`). The database's
  `settings` table holds the rest: two paid jobs at once per account (`max_user_jobs`), twenty videos a day
  that are created and never started (`max_unstarted_runs`), twenty brand kits and fifty tracks (with or
  without a bucket). An upload is read only up to its limit, and the proxy passes on no request above 40 MB.
  Signing in, signing up and asking for a reset are each limited to twenty attempts in five minutes per
  visitor. Kits and tracks cannot be removed in the studio yet, so their limits are per account for good.

Once, by hand:

1. An SMTP service for the two emails the studio sends (the link that confirms an address, the link to choose
   a new password): put `SMTP_URL` (for example `smtps://user:password@smtp.example.com`) and `MAIL_FROM`
   (`Flow Chain <hello@yourdomain>`) in `.env`. Setup refuses accounts without them: an address nobody
   confirmed is nobody's.
2. Optional, for "Continue with Google": a Google OAuth client whose redirect URI is
   `https://<your studio>/auth/callback`; put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Without
   them the button is not shown.
3. Create the bucket and put `STUDIO_BUCKET` in `.env`.
4. Put `STUDIO_ACCOUNTS=1` in `deploy/server.env`.

Then `npm run server:setup` does the rest: it starts the database, makes its three passwords (they are kept
on the server only, in `db.env`, and never shown), creates the tables, and deploys. `npm run server:deploy`
brings the database up to the deployed commit before it starts the new code; `npm run db:migrate` does only
that. The web app gets its own address of the database, the mail server, the bucket and its keys; the worker
alone gets the provider keys and the address that can settle credit.

How it holds: the web app connects as a role that can only read a user's own rows and run the functions a
user may run; every write goes through a function that checks who is calling; settling, granting and
fulfilling payments can only be done by the worker's role, whose password the web app never has. The worker
runs a paid job only when credit is held for exactly that job, whoever queued it. Accounts always work through
the queue (`REDIS_URL`). A studio that is set up to have accounts and finds none configured answers nothing at
all, rather than run without a login.

What to know:

- **The web app tells the database who the visitor is.** It checks the session first, but the database takes
  its word. So a flaw that let someone run code in the web app could read any user's rows and hold any user's
  credit. It could still not grant credit, settle, or fulfil a payment. (With a hosted accounts service the
  database checked each visitor's token itself; running your own trades that away.)
- **The database is yours to look after.** It listens only inside the server (nothing outside can reach it),
  and with `BACKUP_BUCKET` set a copy of it is taken every night by the database itself and stored with the
  runs. Without a backup bucket there is no copy anywhere: accounts, balances and the record of every payment
  are on that one disk.
- **A migration that was applied is never edited.** Setup and deploy compare each file in `db/migrations/`
  with what the database had applied and refuse to go on if one has changed; put every change in a new file.
- Passwords are kept as salted scrypt hashes, sessions and emailed links as the SHA-256 of a random secret: a
  copy of the database signs nobody in. A session lasts 30 days; changing a password ends every other one.
- Guessing at passwords is limited per visitor (twenty attempts in five minutes), never per account: nobody
  can lock someone else out by guessing. One address is sent at most three emails an hour.
- Free work is not limited in number: re-renders and price checks cost you nothing at a provider but use the
  server's CPU. Two long jobs per account at a time is the only brake.
- With a bucket, a file the disk lacks is loaded by the browser straight from R2. Allow the studio's address in
  the bucket's CORS settings (GET, from `https://<your studio>`), or fonts loaded that way will be refused.
- The links in confirmation and reset emails sign in only the browser that asked for them: a link that worked
  anywhere could be used to sign someone into another person's account. Opened elsewhere, a confirmation link
  still confirms the address (the visitor then signs in with their password); a reset link does nothing.
- An account that has a history of payments cannot be deleted: its ledger is kept.

To try it on your machine: `npm run studio:local` (below) starts everything, the database included. For the
database alone: `npm run db:start` (Postgres in Docker, on 127.0.0.1:54330), `npm run db:reset` to empty it and
load it again from `db/migrations/`.

## Payments

With `STRIPE_SECRET_KEY` set (and accounts, which payments need) users buy credit themselves. Without it
nothing below exists and credit is granted by hand as before.

- **What is sold.** `billing/plans.json` lists monthly plans and one-off top-ups, each with its price and the
  credit it grants. The credit is less than the price: the difference is your margin, and credit is still
  spent at what a video costs you. The defaults are Starter $19 → $12 and Pro $49 → $35 a month, and top-ups
  of $10 → $6 and $25 → $16. The better rate is all that sets the plans apart.
- **Two kinds of credit.** A plan's credit is for its month: what is left when the next month is paid for
  expires, and so does what is left when the plan ends. Top-up credit, and credit you grant, never expires.
  Plan credit is spent first. The account page shows both, the plan, and every payment with its receipt.
- **Buying.** `/pricing` shows what is on sale (anyone may read it). A button there opens Stripe's own
  checkout page; the studio never sees a card. "Manage subscription" on the account page opens Stripe's portal:
  cancelling ends the plan with the month that was paid for, and a change of plan starts with the next month
  (the account page shows the new plan's name at once; its price and credit begin with the next invoice).
- **Refunds.** A refund or a dispute in Stripe takes back the credit that payment granted, in proportion. If it
  was already spent the balance goes below zero, and nothing paid starts until it is topped up. Refunding a
  past month of a plan takes its share out of what the user has now, whether or not that month's credit was
  used: grant it back (`npm run studio:grant`) if that is not what you meant.

Once:

1. In Stripe (begin in test mode), copy the secret key to `.env` as `STRIPE_SECRET_KEY`. `STUDIO_HOST` must
   be set in `deploy/server.env`: it is where Stripe will send its confirmations.
2. Edit `billing/plans.json` if the defaults are not what you sell.
3. `npm run stripe:setup` shows what it would create in Stripe and asks before doing it: the products and
   prices, the portal's settings, and the webhook endpoint for `https://<STUDIO_HOST>/api/stripe/webhook`,
   whose signing secret it writes to `.env` (with the endpoint's id, `STRIPE_WEBHOOK_ENDPOINT`, so that a
   secret is never taken for another endpoint's). Run it again whenever `plans.json` changes, and after
   switching between a test key and a live one: a changed price is archived and a new one made, and someone
   subscribed at the old price keeps it until they change plan. With any key that is not a test key it insists
   on `-- --live`; without a terminal it needs `-- --yes`.
4. `npm run db:migrate`, then `npm run server:setup`. Both the web app and the worker get the Stripe key; only
   the web app gets the webhook's signing secret.

How it holds: Stripe tells the studio about a payment by calling the webhook. The web app checks Stripe's
signature on that call and passes on nothing but the event's id. The worker asks Stripe itself for that event
and for the payment as it is now, reads what it grants from the price in Stripe, and records the event's id
together with its effect in one database transaction, so an event delivered twice, a forged call, or an id put
straight into the queue grants nothing. The web app cannot grant credit at all. Every hour (and when it
starts) the worker asks Stripe for the last three days' events and fulfils any that no webhook brought.

What to know:

- The Stripe secret key is in the web app as well as the worker, because the web app opens the checkout and
  portal pages. Someone who took over the web app could use it against your Stripe account (read customers,
  refund, change prices). In the studio they still could not add credit directly; they could change what a
  price says it grants, and the worker never grants more than was paid, so the most that buys is credit at
  cost. A restricted key for the web app is not set up by this version.
- Tax is not handled: prices are charged as listed. Turn on Stripe Tax and add what your country requires
  before selling for real.
- Credit follows money the studio can see: a payment that names a charge, in USD, for at least the credit it
  grants. An invoice you mark as paid by hand in Stripe, one paid from a customer's Stripe balance, or a
  checkout made free by a coupon grants nothing; grant that credit yourself (`npm run studio:grant`).
- Only cards and other methods that confirm at once are tested. A payment that confirms days later is
  fulfilled when it does.
- A price created by hand in Stripe's dashboard is not sold by the studio unless its metadata says
  `studio=flowchain`, a `key` and `credit_usd`; a payment for one that lacks them is logged by the worker and
  retried by Stripe until the price is put right.
- Prices are in USD only, and a plan is billed by the month.

## The whole studio on this machine

`npm run studio:local` starts everything with one command: the local database (Docker), a queue, the worker
and the web app with accounts, and Stripe's test mode when `.env` has a test key and the Stripe CLI is
installed and logged in. It opens the studio in the browser; Ctrl+C stops all of it.
`npm run studio:local -- grant <email> 5` gives an account credit in the local database.

It never uses a database other than the local one, a mail server or the real bucket, whatever `.env` says, and
never a live Stripe key. It sends no email: an account works as soon as it is created.
It does use your provider keys: a video generated there is really generated and paid for, up to the amount
approved on its button.

## The landing page

In a studio with accounts, a visitor without a session who opens the bare address sees the landing page; a
signed-in user sees their videos there. `/pricing`, `/terms` and `/privacy` are on the same, light side. It has
its own layout, typefaces (files in the repository) and styles: nothing of it reaches the studio's pages.

- **The videos on it are real runs.** `npm run make:showcase -- <runId> --slug <name>` publishes a finished
  upright run into `web/public/showcase/<name>/`: the media made small, what the player needs, every look a
  visitor can give it (worked out by the same function a free re-render uses), how it was made, and its
  receipt from the run's own ledger. It is free and calls no provider. Then list it in
  `web/lib/site/showcases.ts`; the first one listed is the one a visitor meets. The files are public: the
  export leaves out machine paths and the ids of your GPU endpoints, and a test checks that.
- **Every number on it is computed** — from those receipts, from what Stripe has on sale, and from
  `web/content/comparison.json`, where another company's price carries the address it was read at and the
  date. **An entry older than 90 days is no longer shown**, and when none is left the comparison table and
  the comparing headline go with it (the page then opens with a plain one). Read the prices again and update
  the dates to keep them. The headline compares only while a video on the page was made the way the studio makes
  them now, and the comparison holds for it.
- **A free first draft (optional).** In the database's `settings` row, `welcome_credit_usd` (0 = off; 0.05
  covers a couple of script drafts and no clip) gives each new account that much once its address is
  confirmed, and `welcome_daily_cap_usd` (5) is the most given away in a day to all new accounts together.
  The page says "Make a free draft" only while a new account would really be given enough for one; a
  sentence typed there is in the new-video form after sign-up. Turn it on with
  `npm run studio:welcome -- --usd 0.05` (`--usd 0` turns it off; `--cap 5` sets the day's limit).
- **Before real money:** `/terms` and `/privacy` say that they are not written yet. Replace them.

## Tests

`npm test` runs unit, ffmpeg, Remotion (headless Chrome), fake-provider pipeline and studio server tests offline
(about 2–3 minutes). `npm run typecheck` runs `tsc` for the pipeline and the studio. `npm run test:e2e` builds the
studio and drives it in a browser against fixture runs and a stand-in CLI (run `npx playwright install chromium`
once); it never reaches a provider. `npm run test:queue` runs the queue and worker against a
throwaway Redis (needs `redis-server` on the PATH; these tests are skipped without it). `npm run test:stack` builds
the server's images and drives the whole Compose stack through the proxy's login with the stand-in CLI, and
checks the Compose and proxy files of both kinds of deployment (needs Docker; the first build takes several
minutes). The tests of accounts, credit and storage are part of `npm test`
and are skipped unless the local database is running (`npm run db:start`; storage also needs Docker for
a stand-in bucket). `npm run test:accounts` drives the studio with accounts in a browser: the landing page (the live player, the
calculator, a topic carried through sign-up, welcome credit, how fast it paints on a slowed-down phone),
sign-up, credit, a video, buying a top-up and a plan, and a second user who sees none of it. It turns a
database-wide setting on for a moment, so run it on its own, not beside `npm test`. Payments are tested against a
stand-in Stripe (`web/test/stripe.ts`); no test reaches Stripe or needs its keys. The RunPod worker's Python tests: `npm run setup:worker` once,
then `npm run test:worker`.
