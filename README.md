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
3. `cp .env.example .env` and fill in `GEMINI_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
4. `npm run flowchain -- doctor` — every line must show ✓ (the first run downloads Remotion's headless
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

Mode 1 = Kling image-to-video, each continuing clip starting from the last frame viewers see of the
previous (fitted) clip. Continue seams are always hard cuts.
Mode 2 = Flux still animated with a Ken Burns camera move at render time (no video API cost).

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
`--characters "…"` sets the character bible directly. Every keyframe of a run shares one Flux seed (`--seed`).

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
`reroll --scene N --stage keyframes` gets new ones. Narration is capped at 16 words per scene, and a 5 s clip
is bought whenever a scene's narration lasts at most 6 s (the fit step stretches it), so a typical 4-scene
Mode 1 run is about $1.35. `rerender` never calls a paid API. `npm run smoke` runs a real 3-scene all-Mode-1
video with `--shots cut,continue,continue`, so two real continuity seams are always exercised (≈ $0.90–1.65,
depending on the 5/10 s clip lengths). `--shots` is a testing override; without it the LLM decides. `npm run
smoke:auto` runs a real 4-scene `--mode auto --style cyberpunk` video with the example music bed, and `npm run
smoke:brand` a 4-scene `--style anime` video with the example brand kit.

Rendering a 16 s 1080×1920 video takes about 1.5 minutes on Apple Silicon (`--render-concurrency` tunes it).

## RunPod (self-hosted keyframes and clips)

Keyframes (SDXL with IP-Adapter character references) and clips (Wan 2.2 image-to-video) can run on your own
RunPod Serverless endpoints instead of fal: roughly $0.20–0.35 per 4-scene video instead of ≈ $1.35. Each run
keeps the provider it was created with, so older fal runs are never affected.

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

Then `npm run flowchain -- run --provider runpod …` (or `PROVIDER_MODE=runpod` in `.env`) and
`PROVIDER_MODE=runpod npm run flowchain -- doctor`. `npm run smoke:runpod` makes a real 4-scene video on RunPod
and is a paid run.

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

With `SUPABASE_URL` set the studio has accounts. Without it, nothing below applies and the studio is the
single-user app described above.

- **Signing in.** Anyone can create an account with an email address and a password, or with Google. Each user
  sees only their own videos, brand kits and music: everything of anyone else's answers "not found". There is
  no proxy login and no password from setup in this mode: you sign up like everyone else.
- **Credit.** Every account has a balance in USD, starting at 0. A generation or a regenerated scene holds the
  amount you approve on its button, the worker runs it capped at that amount, and what it did not spend comes
  back; a draft holds $0.02 for its script (about $0.006). The account page shows the balance and every
  movement. With too little credit the button says so and nothing starts. You add credit with
  `npm run studio:grant -- --email <address> --usd 5` (`--usd -2` takes some back; it prints which project it
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

1. Create a Supabase project. Under Authentication keep **Confirm email** on (an address must then be confirmed
   before its account can sign in) and set up your own SMTP sender before inviting strangers: the built-in one
   sends only a few emails an hour.
2. Turn on Google there, with a Google OAuth client whose redirect URI is
   `https://<project>.supabase.co/auth/v1/callback`. Set the site URL to `https://<your studio>` and allow
   `https://<your studio>/auth/callback` as a redirect.
3. Create the bucket.
4. Put `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` (the connection
   string) and `STUDIO_BUCKET` in `.env`.

Then `npm run db:migrate` creates the tables (the Supabase CLI takes the connection string as an argument, so
it shows in your own machine's process list while it runs), and `npm run server:setup` deploys. Setup gives
the web app only the project's public key, the bucket and its keys, and the job limit; the worker alone gets
the provider keys and the key that settles credit; the connection string is sent to neither. When you update
a server that was set up before accounts existed, run `npm run server:setup` once more (not just
`server:deploy`): the stack now has to be told which login it has.

How it holds: a signed-in user can talk to the database directly, so the database itself only lets a user read
their own rows, and every write goes through a function that checks who is calling; settling and granting
credit can only be done by the worker's key. The worker runs a paid job only when credit is held for exactly
that job, whoever queued it. Accounts always work through the queue (`REDIS_URL`). A studio that is set up to
have accounts and finds none configured answers nothing at all, rather than run without a login.

What to know:

- Every sign-in reaches Supabase from the server's one address, and Supabase limits attempts per address: the
  studio's own per-visitor limit keeps one visitor from using that up for everyone, but a project that many
  people use needs its limits raised (Authentication → Rate limits) and, for open sign-up, a CAPTCHA there.
- Free work is not limited in number: re-renders and price checks cost you nothing at a provider but use the
  server's CPU. Two long jobs per account at a time is the only brake.
- With a bucket, a file the disk lacks is loaded by the browser straight from R2. Allow the studio's address in
  the bucket's CORS settings (GET, from `https://<your studio>`), or fonts loaded that way will be refused.

- The links in confirmation and reset emails work in the browser that asked for them, not on another device:
  the studio only accepts links of that kind, because a link that works anywhere could be used to sign someone
  into another person's account. Email templates changed to the `token_hash` form are not supported.
- An account that has a history of payments cannot be deleted in the Supabase dashboard: its ledger is kept.
- The migration file was changed while this phase was built. A database that had it applied before must be
  reset (`npm run db:reset` for the local one).

To try it on your machine: `npm run db:start` (a local Supabase in Docker), then start Redis, the worker and
the studio with `SUPABASE_URL`, `SUPABASE_ANON_KEY` (and `SUPABASE_SERVICE_ROLE_KEY` for the worker) from
`npx supabase status`.

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

## Tests

`npm test` runs unit, ffmpeg, Remotion (headless Chrome), fake-provider pipeline and studio server tests offline
(about 2–3 minutes). `npm run typecheck` runs `tsc` for the pipeline and the studio. `npm run test:e2e` builds the
studio and drives it in a browser against fixture runs and a stand-in CLI (run `npx playwright install chromium`
once); it never reaches a provider. `npm run test:queue` runs the queue and worker against a
throwaway Redis (needs `redis-server` on the PATH; these tests are skipped without it). `npm run test:stack` builds
the server's images and drives the whole Compose stack through the proxy's login with the stand-in CLI, and
checks the Compose and proxy files of both kinds of deployment (needs Docker; the first build takes several
minutes). The tests of accounts, credit and storage are part of `npm test`
and are skipped unless the local Supabase stack is running (`npm run db:start`; storage also needs Docker for
a stand-in bucket). `npm run test:accounts` drives the studio with accounts in a browser: sign-up, credit, a
video, buying a top-up and a plan, and a second user who sees none of it. Payments are tested against a
stand-in Stripe (`web/test/stripe.ts`); no test reaches Stripe or needs its keys. The RunPod worker's Python tests: `npm run setup:worker` once,
then `npm run test:worker`.
