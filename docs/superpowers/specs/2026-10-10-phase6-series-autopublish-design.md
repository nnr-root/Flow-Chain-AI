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
