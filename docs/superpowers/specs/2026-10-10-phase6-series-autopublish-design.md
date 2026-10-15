# Phase 6: series and publishing by themselves

Date: 2026-10-10. Status: decisions taken, all four tasks built against stand-ins; nothing has reached a real channel.

## 1. Goal

A user sets up a **series** once (what its videos are about and how they look) and from then on gets a new
video of it without filling in a form, and in the end without doing anything: the studio makes the next one on
a schedule, within a budget the user approved, and publishes it to the user's own channel.

This is what the products this one is compared with sell (a look at one of them, facelessreels.com, is in the
phase 4 spec §17 and the owner's report of 2026-10-10): not a video, a channel that runs.

### Non-goals

- Growing a channel: no promise of views, no advice engine, no trend scraping.
- Posting to an account the user did not connect themselves through the platform's own consent page.
- Plans sold by the number of posts (decision D4).

## 2. Decisions (owner's clicks, 2026-10-10)

| | Question | Decision |
|---|---|---|
| D1 | Which platforms first | **YouTube Shorts**; TikTok and Instagram later, on the same structure |
| D2 | How a series is allowed to spend | **A series budget**: a cap for one video and a total for the month, approved once; the series makes videos inside them and stops, and says so, when either or the user's credit runs out |
| D3 | Whether a video is seen before it is published | **Chosen for each series**; "show me first" is the default |
| D4 | Pricing | **Credit stays**: a series' video takes from credit what it cost, like any other |

## 3. What a series is

A **series** belongs to one user and has: a name; a **premise** (what its videos are about, in a sentence);
a **recipe** (the new-video form's choices: shape, scenes, look, motion, clip size, brand kit, music, captions,
cuts, and so on); and, from task 2, its schedule, its budget and whether its videos are shown first.

A video made from a series is an ordinary run that also names its series (`runs.series_id`). Everything a run
can do (preview, regenerate a scene, re-render with another look) it still can.

**The topic of an episode** is built, not typed: the premise, the episode's number, and the titles the series
has already made, so the script model writes about something else. No new paid call is added for it: the
script stage, which is paid for anyway, is what reads it.

## 4. Money (D2, D4): the standing approval

Today every paid job begins with a click that names an amount, and the web app holds that amount from the
user's credit before the job is queued (`reserve_credit`, as the user). A series that runs by itself has no
click. What stands in for it is the approval the user gave when they set the series up:

- `per_video_cap_usd`: no video of the series may hold or spend more.
- `monthly_budget_usd`: the videos of one calendar month together may not spend more.
- The series is `active` or `paused`. Only the user makes it active.

A new SQL function, **granted to the worker only**, `reserve_for_series(series_id, run_id, kind, cap)`, holds
credit for a series' job when, in one transaction and under the user's row lock: the series is active and is
that user's; the cap is not above `per_video_cap_usd`; what the series has spent this month plus what it holds
plus this cap is not above `monthly_budget_usd`; and the balance covers it. Otherwise it refuses and the series
is paused with the reason (`budget`, `credit`), which the user is shown. Settling is unchanged: `settle`.

This is a function that moves money, so by the project's rule it needs a database test for every ordering it
could meet, added to the matrix in `test/db/billing.test.ts`: a reservation of a series racing a top-up, a
refund, a plan's month ending, another series of the same user, the user pausing it.

The web app is never given this function: a web app that was taken over can already spend a user's credit on
that user's own videos (phase 5 spec §4.3), and must not gain a way to do it on a schedule nobody approved.

## 5. The schedule (task 2)

`cadence`: `manual` (only the button), `weekly3`, `daily`, `daily2`. The worker, which is the one process that
may start paid work, looks every few minutes for active series whose next episode is due and that have no
video being made. For each it registers a run, holds the cap with `reserve_for_series`, and queues the same
two jobs a user's clicks would (`draft`, then `generate` at the price the plan gives, if that is within the
cap). A job is still never retried on its own: an episode that fails stays failed, is shown, and the series
waits for its next slot.

## 6. Publishing (tasks 3 and 4)

- **Connecting a channel.** On the account page, "Connect YouTube" sends the user to Google's consent page for
  the upload scope only. What comes back (a refresh token) is the user's, and is as dangerous as a password
  for that channel: it is kept encrypted with a key that only the worker has, in a table neither role can
  read directly; the web app can see only that a channel is connected and what it is called.
- **Uploading** is the worker's: it alone holds the key that opens a token. A `publish` job for a finished run
  uploads `final.mp4` with the run's title, a description and `#Shorts`, and records the video's address or
  the platform's refusal.
- **D3.** A series with "show me first" leaves a finished episode waiting, with a Publish button on its page
  (that click queues the `publish` job). A series without it queues the job itself when the episode is done.
- **A stand-in** for YouTube, reached through `YOUTUBE_API_BASE` as Stripe's is, so no test reaches Google.

### What the owner has to do before any of this can reach a real channel

- A Google Cloud project with the YouTube Data API v3 switched on, and an OAuth client for the studio's
  address. Google must **verify** the app for the upload scope; until it has, uploads from an unverified app
  are locked as private, and the consent page warns the user.
- The API's daily quota is small at first (an upload is a large part of it); a higher one is asked for with a
  form and an audit.
- For TikTok and Instagram later: their own applications and reviews; TikTok keeps an unaudited app's posts
  private, Instagram needs a business or creator account and a public address for the video file.

These are claims about other companies' rules as remembered on 2026-10-10. They are to be read again at the
source when task 3 begins, and that reading recorded here.

## 7. Order of work

1. **Series by hand** (built, §8): the table, the pages, "Make the next episode" as a click that starts an
   ordinary draft with the series' recipe. No money is moved in any new way.
2. **The schedule and the budget**: the columns of §4–5, `reserve_for_series` with its tests, the worker's
   look-out, pausing with a reason, the series page's budget and history.
3. **Connecting YouTube**: consent, the token kept as §6 says, the stand-in, the account page.
4. **Publishing**: the `publish` job, show-me-first, the episode page's state and link.

Tasks 2–4 each touch the worker and the database's grants; 2 touches credit. They are done one at a time with
their tests, not together.

## 8. Task 1 as built (2026-10-10)

- `db/migrations/20261010000001_series.sql`: `series` (user, name, premise, recipe as JSON), `runs.series_id`,
  read access for the web role to a user's own rows, and three functions for the web role: `create_series`
  (twenty to an account), `remove_series` (its videos stay, no longer in a series), `create_series_run` (a
  run registered as `create_run` registers one, and tied to the caller's own series).
- `web/server/series.ts`, `web/app/api/series/…`, `web/app/(studio)/series/…`: the list, the form (the
  new-video form's choices, saved instead of spent), a series' page with its episodes and **Make the next
  episode**, which is the existing paid draft (the script, held from credit as ever) with the built topic.
- Only in a studio with accounts: a series is rows in the database. Without accounts the pages do not exist.
- The landing page says nothing of series yet: it will when a series can run by itself (task 2), and of
  publishing when a channel can be connected (task 3). A claim is shown only while it is true.

## 9. Task 2 as built (2026-10-10): the schedule and the budget

**In the database** (`20261010000002_series_schedule.sql`, `…03_series_month.sql`):

- A series has a `cadence` (`manual`, `weekly3` every 56 hours, `daily`, `daily2`), the two amounts of its
  approval, a `status` with the reason it stopped, when its next video is due, and the video it is making with
  the step that has reached.
- **For its owner** (web role): `set_series_schedule` (both amounts or none; the month's budget at least one
  video's limit; makes it active and due) and `set_series_status`.
- **For the worker only:** `start_series_episode` (registers the run as the owner's, ties it, holds the script's
  cost, moves the due time on by one interval from now), `reserve_for_series` (holds the rest, for the video
  being made, once), `finish_series_episode` (frees the series, and stops it with a reason when told to).
- **They do no arithmetic on a balance.** Each checks the standing approval under a lock on the series' row
  (active; not above the limit for one video; the month's spend plus what is held plus this amount not above
  the budget) and then has `reserve_credit` itself hold the amount, asked in the owner's name for that one call
  (`app.user_id` is set for the call and put back, also when the call refuses). `settle` is untouched.

**In the worker** (`web/worker/series.ts`): every two minutes (`WORKER_SERIES_MS`) it looks at each active series
with a schedule. One with nothing in the making and a video due is begun: the topic is built, the episode
started, the same `draft` job queued that a click queues. One whose script is written is priced with the CLI's
own `plan`; above the limit for one video it is left as a draft and the series stops (`cap`); otherwise the
price is held and the same `generate` job queued, with that price as its budget and its cap. A video that ends
without a film stops the series (`failed`): nothing is retried. Credit or budget that does not cover a step
stops it (`credit`, `budget`). The jobs are checked by the worker's existing rules like any other.

**In the studio:** the series page has "By itself": how often, the two amounts, and a button that names them
("Approve: up to $0.40 a video, $3.00 a month"); what the month has used; why it is stopped; Stop it / Let it
go on. `PATCH /api/series/<id>`.

**Rulings and parked**

- **The 648-case matrix is not extended.** The rule asks for it when `reserve_credit`, `settle`, a refund or a
  fulfilment changes; none did. What is new is a gate in front of `reserve_credit`, and that gate has its own
  tests under concurrency (`test/db/series.test.ts`: twelve reservations at once against a budget that fits
  one; eight starts at once; the budget counted with what is held; a refusal leaving no run and nothing held;
  the owner's name given back after the call). Ruling: sufficient for a gate that adds no balance arithmetic.
- **The database became a source of work.** Until now a job reached a worker only through its own Redis. A
  series is a row every worker on the database can see, and a developer's tests and their local studio (which
  has real provider keys) share one database: a test's series could have been made into a real video. So a
  worker drives a series **only when its owner's folder is on its own disk**, and the web app makes that folder
  when a schedule is approved. A test holds another studio's worker to it.
- A user who opens the video their series is making and clicks Generate themselves is not in the way: the
  series sees credit held for the run, waits, and takes the result as its own.
- The month is the database's calendar month (UTC), not thirty days from the first video. Parked: a user in
  another time zone sees the budget turn over at an odd hour.
- A series that stood still makes one video when it goes on, not the ones it missed.
- `daily2` with a long video and two jobs a user is the per-user limit: a series' step waits its turn; nothing
  is skipped. Parked: saying so on the page.
- Not built: mail when a series stops. Its owner sees it on the page only.
- The landing page still says nothing of series (task 1's rule): it will once publishing exists, so that
  "runs by itself" is said together with where the videos go.

## 10. Tasks 3 and 4 as built (2026-10-10): a user's own channel, and publishing to it

The owner, before these were begun: it is the user who connects their account, and the studio publishes to
that account in their name, as the products it is compared with do. That is what §6 says and what was built:
the studio has one client at the platform (as each of those products has), and every user gives their own
consent on the platform's page. The studio never has a channel of its own and never a user's password.

**Who holds what**

| | Web app | Worker |
|---|---|---|
| The client's public id (`YOUTUBE_CLIENT_ID`) | yes: it builds the address of the consent page | yes |
| The client's secret (`YOUTUBE_CLIENT_SECRET`) | no | yes |
| The key tokens are sealed with (`CHANNEL_KEY`) | no | yes |
| A user's token | never: the consent's code goes to the worker unexchanged | sealed in the database, opened only to post |

- `db/migrations/20261010000004_publishing.sql`: `channels` (the web role has no access to the table at all; it
  learns a channel's name through `my_channels()`), `posts` (a video on a channel once; a user reads their own),
  a series' `channel_id` and `review_first`. For a user: `unlink_channel`, `request_post`,
  `set_series_publishing` (only to a channel of their own). For the worker: `link_channel`, `post_for_series`,
  `record_post`.
- `web/worker/vault.ts`: AES-256-GCM; the user's id is part of what is checked, so a sealed token moved to
  another user's row does not open. `web/worker/publish.ts`: exchanges a code, reads which channel it is, seals
  and keeps the token; for a post, checks that the post's run and channel are both its user's own, opens the
  token, asks for an access token, uploads `final.mp4` in a resumable session, records where it is or why not.
- `web/server/channels.ts`, `/auth/youtube`, `/auth/youtube/callback`, `/api/channels`, `/api/runs/<id>/publish`:
  consent with `state` and PKCE in the browser's cookie, bound to the user who began it; the answer's code goes to
  the worker through the quick queue; the account page says how it went in one of four fixed sentences.
- **D3.** A finished video's page has Publish for each connected channel. A series has "Where its videos go":
  a channel, and "Show me each video first" (on by default). Off, the worker posts a finished episode itself.
- **A post is never lost and never doubled.** It is a row before the worker is told; a post whose job never
  arrived is found by the worker a minute later (only for users whose files are on its disk, as with series);
  the worker sends one post once at a time; what is there is not changed again.
- What a user is told when it goes wrong is one of the studio's own sentences; the platform's answer stays in
  the worker's log.
- Modes by environment: without `YOUTUBE_CLIENT_ID` (web) none of it exists (404, no panels); a worker without
  all three settings publishes nothing. The deploy planner takes the three together or not at all.

**The platform's rules, read again on 2026-10-10** (from secondary sources; to be read at Google's own pages
before a real client is made): the upload scope is a restricted one; a project that has not passed YouTube's
API audit has every upload **forced to private**; uploads are counted in a bucket of their own, about a hundred
a day for a new project (a change of late 2025; older guides say 1,600 units of 10,000). So until the owner's
project is audited, a "published" video is on the user's channel and only they can see it.

**Rulings and parked**

- **Not verified against Google.** Everything here ran against `web/test/youtube.ts`. The first real consent
  and upload need the owner's Google Cloud project, and are the owner's click.
- The upload says the video is not made for kids and that it contains synthetic media. Parked: letting the
  user choose the title, description and visibility; the title is the run's own.
- A video is uploaded in one request (they are a few megabytes); the resumable session is not resumed after a
  break. Parked.
- Uploads share the worker's four quick slots with prices and health questions. Parked: a queue of their own
  when there are many.
- Disconnecting a channel deletes its token here; it does not withdraw the consent at Google. Parked: calling
  Google's revoke address, and saying so on the page.
- TikTok and Instagram: not begun (D1).
- The landing page still says nothing of series or publishing. It may once a real video has reached a real
  channel through a real audited client; until then the claim would be about a stand-in.

## 11. First real consent, and what waits for a server and a domain (2026-10-10)

**What is now verified against Google itself.** The owner made a Google Cloud project (YouTube Data API v3 on,
an OAuth client for `http://127.0.0.1:3131/auth/youtube/callback`, the app in "Testing" with the owner as a
test user), put the three settings in `.env`, and connected their own channel in the local studio. The
database holds the channel by its name with a sealed token of 131 bytes: the consent page, the exchange of the
code by the worker, reading which channel it is, sealing and keeping the token all worked against the real
thing. **Not verified yet: an upload.** No post has been asked for (the account had no video and no credit).

**Parked by the owner until there is a server (VDS) and a domain.** In this order, when they exist:

1. **Publish the app** (Google Auth Platform → Audience → Publishing status → Publish app). While it is in
   "Testing", a user's permission lapses after seven days and only listed test users can connect. After it,
   every channel is connected once more (a permission given during testing still lapses). An unverified app in
   production shows Google's "not verified" warning and is held to about a hundred users.
2. **Add the server's redirect address** to the OAuth client: `https://<domain>/auth/youtube/callback`.
3. **Write `/terms` and `/privacy`.** They still say that they are not written; Google's verification and
   YouTube's audit both ask for a published privacy policy on a domain the owner has verified.
4. **Ask for verification** of the app (same screen): the domain, the two pages, a short video of the consent
   and of what the permission is used for, and a written reason for each scope. It removes the warning and the
   limit on users.
5. **Ask for YouTube's API audit** ("YouTube API Services: Audit and Quota Extension" form). Until it is
   passed, every video the project uploads is kept private on the user's channel. This is separate from 1 and 4.

Until then publishing is for the owner's own channel on the owner's own machine: the permission is given again
each week, and what is uploaded is visible to the owner only. Nothing on any page says otherwise.

These are Google's rules as remembered and as read from secondary sources on 2026-10-10; each is to be read on
Google's own page when its step is taken, and what was found recorded here.

## 12. Credits, and three plans measured in minutes (owner's direction, 2026-10-10)

The owner: show a customer credits, as other video tools do, not dollars; let them not see what a video costs
the studio; and size three plans by how much fully generated video each covers (about 5, 15 and 45 minutes),
since most people will make more than that with stills and mixed videos.

This replaces the phase 3.4 pricing (Starter $19 for $12 of credit, Pro $49 for $35) and the principle of the
phase 4 page that a customer is shown costs in dollars. What stays: a customer is shown the most a video can
use before it is made and approves it; what is not used comes back; every figure on a page is worked out.

**The unit.** Nothing in the database, the worker or the pipeline changed: they account in dollars of cost to
four decimals. A credit is that same amount in another unit, `CREDITS_PER_USD = 2000` (`web/lib/credit.ts`):
one credit is a twentieth of a cent of cost. `amount()` (`web/lib/api.ts`) shows credits wherever the studio
has customers (accounts) and dollars in the owner's own studio without accounts, which is the owner's bill.
`money()` is for real money and is always dollars: a plan's price, a payment, a refund. The two amounts of a
series' approval and a new video's budget are typed in credits and kept in dollars. A job's output shown to a
customer has its dollar figures turned into credits (`publicLog`).

**What a fully generated video costs** (`web/content/measured.json`, dated and sourced like another company's
price, and like one not used once it is ninety days old): **$0.141** for four scenes, every one a moving clip,
at the standard clip size (phase 5 spec §9.16). A scene runs about five seconds in the videos on the page, so
that is about twenty seconds: **about $0.42 a minute**, or about 850 credits. From the same checks: at the
larger clip size about twice that; a video of stills only, about a third (the script, the portrait, the voice
and four pictures, with the starts those pay).

**The plans** (`billing/plans.json`; they reach Stripe when the owner runs `npm run stripe:setup`):

| | Price | Credits | Cost if all are used | Minutes fully generated (worked out) | Left after cost, before Stripe's fee |
|---|---|---|---|---|---|
| Starter | $19 / month | 5,000 | $2.50 | 5 | $16.50 (87%) |
| Creator | $39 / month | 15,000 | $7.50 | 17 | $31.50 (81%) |
| Pro | $89 / month | 45,000 | $22.50 | 53 | $66.50 (75%) |
| Top-up $10 | $10 | 2,000 | $1.00 | 2 | $9.00 |
| Top-up $25 | $25 | 6,000 | $3.00 | 7 | $22.00 |

- Each plan is cheaper for a credit than the one before; a top-up is dearer than any plan. A test holds both.
- The plans are built around 5, 15 and 45 minutes and give somewhat more (the measured figure leaves about a
  sixth to spare): a start that takes longer or a clip made twice does not make the plan fall short of what the
  page says. The page says what the figures give, rounded down (`fullyGeneratedMinutes`), and says nothing
  about minutes when the measurement is stale or missing.
- **The margin is the plan, not the video.** A user's credits are a fixed amount of cost however they are
  spent: someone who makes only stills gets three times the videos from them, and the studio's cost for that
  plan is the same $2.50. What the studio does not control is how much of a plan goes unused; unused plan
  credits expire with the month, as before.
- To change the margin later: change what a plan's price covers (`creditUsd`), or the rate. Raising the rate
  shows every balance as more credits and every video as costing more credits by the same factor, so it changes
  nothing for credits already held and gives new purchases less.

**Not counted above:** Stripe's fee (about 3% and 30 cents a payment), the server, storage, the worker's idle
starts that no video pays for, refunds, and tax. They come out of the last column.

**What the page no longer says.** No dollar figure for what a video used: receipts, the making timeline, the
shelf, the questions and the calculator's "a video uses about" are in credits. The calculator still works out
the month's price in dollars from what is on sale (that is a price, not a cost) and still sets it beside other
companies' dated prices; the headline that compares with them is shown only while that comparison holds, as
before, and with these plans it no longer holds: a month here is no longer "about what others charge for the
clips", and the page opens with the plain headline instead. That is the rule working, not a fault.

**Rulings and parked**

- **A credit's worth can be worked out by anyone who looks.** The API's answers still carry dollars of cost (a
  browser's network panel shows them), and the three showcase receipts in `web/public/showcase/` are in
  dollars. Hiding them means changing every answer's shape and re-exporting the showcases. Parked: it is a
  day's work across the routes and their tests, and until then the cost is out of sight, not secret.
- The three videos on the landing page were made before the cost came down (458, 634 and 1,625 credits for
  about twenty seconds each); a fully generated video now uses about 280. They are what they were; a new
  showcase made today would show the plans in a better light. Parked: it is a paid run, the owner's click.
- The stand-in Stripe of the tests still sells the old sizes (a $19 plan for $12 of cost): the tests are about
  the mechanism, not the price list. `web/test/credits.test.ts` holds the real list.
- Users of an existing plan keep its old price and credit until they change plan (Stripe's behaviour, phase
  3.4). There are none: nothing is live.
- A welcome credit of $0.05 shows as 100 credits.

## 13. Only plans, by the month or the year, at the market's prices (owner's direction, 2026-10-10)

The owner: no top-ups for now, only plans, monthly and yearly; a year costs ten months; and the §12 prices were
far too low for what is sold ("45 minutes of fully generated video for $89 is giving it away"). The plans are
built around 5, 15 and 45 minutes, and the page is to say those numbers, not the 17 and 53 the arithmetic gave.
Where this section and §12 differ, this one wins. The unit, the measured cost and everything about how credits
are shown are as §12 has them.

### 13.1 What others charge (looked up 2026-10-10; secondary sources where a vendor's page gave no figures)

| Who | What it is | Monthly tiers | What that buys |
|---|---|---|---|
| FacelessReels / AutoShorts | scheduled faceless shorts, mostly stills with motion effects | $19 / $39 / $69 | 3 posts a week, daily, twice daily |
| Revid | the same market, more generated footage | $39 / $99 / $199 | credits |
| Higgsfield | generated clips, sold in credits | $19 / $59 / $129 | 270 / 1,200 / 3,000 credits; about $0.82 to $1.38 for a usable clip of a few seconds |
| Luma | generated clips | $30 / $90 / $300 | 10,000 / 40,000 / 150,000 credits at 10 to 20 a second |
| Runway | generated clips | $15 / $35 / $95 | credits |
| Kling | generated clips | about $10 / $37 / $92 / $180 | credits |

Read together: the schedulers charge $19 to $69 for videos that are mostly stills; whoever sells generated
footage with a finished video around it charges $39 to $199; clip generators alone charge $15 to $300 and leave
the script, the voice, the captions and the edit to the customer. A minute of fully generated footage bought as
clips at Higgsfield's rates is $10 to $16 before any of that. The studio sells the finished video.

### 13.2 The plans

| | A month | A year (ten months) | Credits a month | Minutes built around | Cost if all are used | Left of a month's price | A minute costs the customer |
|---|---|---|---|---|---|---|---|
| Starter | $39 | $390 | 5,000 | 5 | $2.50 | $36.50 (94%) | $7.80 |
| Creator | $99 | $990 | 15,000 | 15 | $7.50 | $91.50 (92%) | $6.60 |
| Pro | $199 | $1,990 | 45,000 | 45 | $22.50 | $176.50 (89%) | $4.42 |

Before Stripe's fee (about 2.9% and 30 cents: $1.43, $3.17 and $6.07 a month) and before the server, the idle
time of the engines and the domain, none of which a video's receipt carries. By the year a plan grants twelve
months of credits for ten months' price, so what is left is $360 of $390, $900 of $990 and $1,720 of $1,990
(92%, 91%, 86%). Each larger plan is cheaper per credit than the one before; a test holds that.

The tiers are Revid's, on purpose: it is the nearest thing to what the studio sells, and a customer comparing
the two sees the same three numbers. They are a proposal the owner can change in one file; nothing else needs
editing (`npm run stripe:setup` archives the old prices and makes the new).

**What the page says.** A plan carries `minutes` (5, 15, 45) in `billing/plans.json`; it travels to Stripe as
the price's `metadata.minutes` and back in the catalogue. `minutesOnSale` says the smaller of that and what the
measured cost gives: 5,000 credits cover 5.9 minutes today, and the page says 5. Should video come to cost more,
the page says the smaller true figure; should the measurement go stale, it says nothing. Never more than is so.

**What the higher prices cost the page.** The landing page's opening claim that a finished video costs about
what others charge for the clips alone no longer holds at these prices against the cheapest clip generator
listed, so `clipsClaimHolds` is false and the page opens with its plain line. The comparison table shows the
studio dearer than Luma for raw clips. Both are the page being truthful, and neither was changed.

### 13.3 By the year

`yearlyMonths: 10` in the file makes, for every plan, a second thing on sale: key `<plan>-yearly`, a Stripe
price billed once a year at ten times the month's, with `credit_usd` twelve times the month's and
`metadata.plan` naming the plan. No SQL changed. A year's invoice is one invoice, and credit is only ever
granted by an invoice, so **the year's credits are granted at once** and are the customer's until the next
year is paid for. Ruling: this is more generous than twelve monthly portions (nothing lapses within the year),
and the alternative, a worker handing out credit month by month with no payment behind each grant, would be a
second way of creating credit, which the money rules do not have. The studio's cost is bounded the same either
way: no more than the credits granted. A refund takes back what it should, as for any payment.

The worker already named a plan by `metadata.plan` before `key`, so a yearly customer's plan is `starter`, the
pricing page marks it as theirs under either way of paying, and the one-plan-at-a-time rule covers both.

### 13.4 Stripe's portal: monthly plans only

Found while building: the portal lets a customer switch between the listed prices without proration. A switch
that changes the interval (month to year) is billed by Stripe at once, on an invoice whose reason is
`subscription_update`; the worker grants credit only for `subscription_create` and `subscription_cycle`, on
purpose (a proration is not a month). A customer would have paid for a year and been given nothing. So the
portal lists only the monthly prices (`ensurePortal`). A customer goes to a year by ending the plan and
subscribing again; a yearly customer can cancel in the portal and cannot switch there. Parked: granting on an
interval change, which needs a database test for every ordering first (money rules).

### 13.5 Top-ups

Not on sale: `topups: []`. The mechanism is untouched (`fulfil_topup`, the `purchase` ledger rows, their tests,
the account page's labels for payments already made), so listing one in the file sells it again. Copy that
spoke of top-ups now speaks of them only when one is on sale.

### 13.6 Checked, and not

Ran: the planner and catalogue unit tests, a billing test that buys a plan by the year through the stand-in
Stripe (144 dollars of credit for 190 paid, under the plan's own name, replaced at renewal), the database
tests, the accounts browser suite (the monthly and yearly choice on `/pricing`), the studio browser suite.
`test/unit/db-migrations.test.ts` had been left listing three migrations when phase 6 added four; it lists
seven now. Not done: `npm run stripe:setup` (the owner's click), so the real Stripe test account still sells the
§12 prices; nobody has looked at the pricing page with the real three plans on it; a real yearly payment.


## 14. A year's credits come a month at a time (owner's direction, 2026-10-10)

The owner, on §13.3: not all at once. A plan paid by the year gives the same credits every month as the plan
paid by the month, as other subscriptions sold by the year do. **This replaces §13.3 and its ruling.** The
prices, the portal rule (§13.4) and everything else in §13 stand.

§13.3 refused this because it needs credit granted without a payment behind each grant. It is built so that
this stays one narrow thing:

**What a yearly price says.** `credit_usd` in a price's metadata is what one month grants, for a monthly and a
yearly price alike (`billing/plans.json`: the yearly item has the plan's own `creditUsd` and `minutes`). The
worker reads twelve months from the price being billed by the year, and refuses an invoice that paid less than
the twelve months of credit it stands for.

**The invoice** (`fulfil_plan_period`, migration `20261010000005`). The worker calls it for every plan invoice,
with the number of months paid for. It is `fulfil_plan_invoice`, unchanged, and in the same transaction a row in
`plan_years`: the subscription, the invoice, a month's credit, how many months are still to come (eleven), and
when the year ends. A plan by the month removes the row. There is no moment at which a year is paid for and its
months are not owed. A second subscription beside a live one gets what its invoice grants and no row (owner's
to put right; its outcome says so).

**Each month after** (`grant_plan_month`, the worker's alone, asked for every row with months to come in the
hourly pass that also asks Stripe for missed events). It takes only a user id. It grants a month's credit when
all of these hold, and says which does not otherwise: there is a row; months are left; the day has come
(counted back from the year's end, so the second month begins one month after the first); the subscription the
row names is the user's and live (one set to end with its year is live until then); the invoice's refunds leave
a month still owed (a refund takes months off the end: `floor(months × (1 − refunded / paid))` are owed in all).
Then, exactly as at a monthly renewal: what is left of last month expires, the month counter moves on, a debt
is paid first. The count is moved under the user's lock, so two workers, or one asking twice, grant once. The
invoice's payment row is moved to the new month, so a refund from then on takes from the current month and
notes what is out with jobs, as it does for a payment by the month.

A worker that was away for months is owed them one call at a time; each but the last expires with the next, so
one month's credit is there, as if it had never been away.

**Why any worker may do it.** Unlike a series, this needs nothing from a disk and buys nothing: every worker on
a database would do the same thing, and the database lets only one of them. So there is no `here()` check, on
purpose.

**What a customer sees.** `/pricing`: the same "N credits every month" under either way of paying, the year's
price, and "Twelve months for the price of 10" worked out from the two prices. The account page: the plan's
credits "to use by" the day the next month comes, and that day beside the renewal date (`plan_years` is readable
by its own user and nobody else; `monthsBefore` counts the day as the database does).

**Margins by the year** change with this: a year now costs the studio at most twelve months of credit as
before ($30, $90, $270), but never more than one month's at a time, and a customer who uses little leaves the
rest each month: $390, $990 and $1,990 for at most $30, $90 and $270 of cost.

**Checked.** In the database: a year month by month to its twelfth and no further; not before its day; asked
twice; a worker away for three months; an ended subscription and one set to end; a refund of all and of half;
the next year; a plan by the month after; once per event and per invoice; the two roles. The 648-case sum of a
refunded month with two jobs out runs a second time for the second month of a year, where "renews" is the
worker's grant (1,296 cases). Through the stand-in Stripe: a year bought at Checkout, a month's credit, the
worker's pass before and after the day, the next year's invoice; a year priced below its credit is not
fulfilled. **Not checked:** a real yearly payment in Stripe's test mode; a real month going by.

**Parked.** A refund in part takes whole months off the end and a share of the current month; it does not
reach back into months that have expired (nothing is left of them to take). Telling a customer by email that a
month's credits have come.

### 14.1 In Stripe's test mode (owner's click, 2026-10-10)

The owner kept the prices and the minutes as they are (5, 15 and 45; doubling them was weighed and left) and
had `npm run stripe:setup` run. The test account now sells the three plans by the month ($39, $99, $199) and
by the year ($390, $990, $1,990, each with a month's credit on the price); the earlier prices and both top-ups
are archived; a second run found nothing to change. Still not done there: buying a year at Checkout, and a
month going by.

## 15. No budgets (owner's direction, 2026-10-10)

The owner: remove the parts that limit by a budget; a user is told when their credit does not cover something,
and that is enough. Asked which, the owner chose both: the new-video form's budget, and a series' limit for one
video and budget for the month. **This replaces §4 and D2 ("a series' budget"), and the parts of §9 that
describe the two amounts.**

**The new-video form** no longer has a budget, in credits or in dollars. The field never limited what a video
could spend (that is the amount its owner approves once the script is priced, and the cap the job runs under);
it told the auto mode rules what to keep the estimate under, turning moving scenes into stills to fit.
`draftArgs` now passes `NO_BUDGET_USD` (100, the most a video can be approved for), so the rules never demote a
scene for cost. The request no longer has `budgetUsd`, and the health answer no longer carries a default one.
The CLI is unchanged: `--budget` and `FLOWCHAIN_BUDGET_USD` are still the owner's own.

**A series** (migration `20261010000006`): `set_series_schedule(id, cadence)` takes no amounts; the two columns,
their constraint and `series_month_usd` are gone; `hold_for_series` no longer refuses with `over_cap` or
`over_budget`; a worker can stop a series for `credit` or `failed` only. Series that a limit had stopped stay
stopped, shown as stopped by their owner, until the owner lets them go on: removing a limit is not a reason to
begin spending without them. Everything else in §9 stands: only the worker begins a series' video or holds
credit for one, under a lock on the series' row, for a series that is active and has a schedule, through
`reserve_credit` in the owner's name. The page still shows what the series has used this month, as information.

**What this means, said plainly.** A series set to two a day now makes videos until its owner's credit does
not cover the next one. With a plan, that is the month's credits and whatever else the account holds; nothing
smaller stands in between. It stops then, and its page says "Your credit did not cover its next video." A video
whose price turns out higher than usual is made if the credit is there.

**The owner's premise that a user is told "in the UI or by email" is half true today.** The page says why a
series stopped. No email is sent: that was listed as not built in §10 and is still not. Parked, and now worth
more than before: an email when a series stops, and one when credits are nearly used up.

**Checked.** Database: a schedule with no amount, the old function and columns gone, a video of any price the
credit covers, refusal and nothing held when it does not, the two reasons a worker may give, races on holds and
starts; twice. The worker against the stand-in CLI: a video dearer than any earlier limit is made; one the
credit does not cover stops the series with only its script bought. Browser: no amount fields, the button
"Approve: one a day, from my credits". Not checked: a real series on real engines.

## 16. Plans that still cover their minutes with the hosted voice (owner's direction, 2026-10-11)

New runs are spoken by the hosted voice again (phase 5 spec §11), which costs about $0.26 more a minute of video
at its dearest price ($0.226 for the measured four scenes against $0.141). The owner: keep 5, 15 and 45 minutes.
What a voice costs is part of what a video costs, as it always was: it is not a separate charge, and it is not
free (a free voice would make the videos of stills, which are mostly voice, cost the studio far more than their
credits). So the plans grant more credit:

| | A month | Credits a month | Minutes built around | Covers (worked out) | Cost if all are used | Left of the price |
|---|---|---|---|---|---|---|
| Starter | $39 | 8,000 (was 5,000) | 5 | 5 | $4 | $35 (90%) |
| Creator | $99 | 24,000 (was 15,000) | 15 | 17 | $12 | $87 (88%) |
| Pro | $199 | 70,000 (was 45,000) | 45 | 51 | $35 | $164 (82%) |

By the year (ten months' price for twelve months' credits): $342 of $390, $846 of $990, $1,570 of $1,990 (88%,
85%, 79%). Each plan is still cheaper per credit than the one before. Before Stripe's fee, the server and the
hosted voice's monthly subscription. The prices reach Stripe when the owner runs `npm run stripe:setup` (it
archives the old prices and makes these); until then the old ones are on sale.

## 17. The cost measured with the hosted voice, and the plans' credits (owner's direction, 2026-10-15)

The owner: measure again with the hosted voice and set the prices by it. The video §12 measured was made again,
the same request (four scenes, every one a moving clip, 480p, cinematic history, the male narrator, English), now
spoken by the hosted voice: run `20261015-101855-ccc5f8`, 19.2 seconds.

| | Script | Voice | Portrait | Pictures | Clips | Clip worker's start | All |
|---|---|---|---|---|---|---|---|
| §12 (own voice, 2026-10-10) | $0.0055 | $0.0164 | $0.0131 | $0.0062 | $0.0998 | (in the clips) | $0.141 |
| Now (hosted voice) | $0.0055 | $0.1026 | $0.0140 | $0.0062 | $0.0893 | $0.0275 | **$0.2451** |

The start of the clip worker could not learn its cost and was kept at what was expected (`abandonedUsd`), as it is
charged to a run: it is in the figure. **$0.735 a minute** by the page's own arithmetic (five seconds a scene), against
$0.68 worked out in phase 5 §11.3. `measured.json` holds it now, with no other voice to price it at.

**The plans keep their prices and 5, 15 and 45 minutes, with a fifth to spare again.** At $4, $12 and $35 the
measured cost covered 5.4, 16.3 and 47.6 minutes: six to nine percent to spare, against the sixth §12 kept for
starts that take longer and scenes made again. The credits are now:

| | Price | Credits a month | Covers (worked out) | Left if all are used | After Stripe's fee | After the fee, the voice at the Creator plan's rate |
|---|---|---|---|---|---|---|
| Starter | $39 | 9,000 ($4.50) | 6 minutes | 88.5% | 84.8% | 86.1% |
| Creator | $99 | 27,000 ($13.50) | 18 minutes | 86.4% | 83.2% | 84.7% |
| Pro | $199 | 80,000 ($40) | 54 minutes | 79.9% | 76.8% | 79.1% |

By the year (ten months' price, twelve months' credits): 86.2%, 83.6% and 75.9% if every credit is used, 83.2%,
80.7% and 73.0% after the fee. Each plan is still cheaper per credit than the one before.

- **What a credit costs the studio is less than what it is charged at.** A line is charged at `ttsPer1kChars`, 0.30
  a thousand characters, the dearest the hosted voice is sold at; the Creator plan's characters are 0.22 and the Pro
  plan's 0.198. At the Creator rate the measured video costs $0.2177, not $0.2451: the last column.
- **Not in these figures:** the hosted voice's subscription (a fixed monthly cost: the Starter plan the owner is on
  is $5 for 30,000 characters, about half an hour of narration; a studio with customers needs Creator or Pro), the
  server, and credits a customer does not use, which expire with the month and are all margin.
- The new prices reach Stripe with `npm run stripe:setup` (the owner's click).
