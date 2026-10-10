# Phase 4 — Landing Page and Marketing UI: Design

Date: 2026-10-08. Status: approved section by section by the owner (design system; structure and funnel;
the live hero, calculator and free draft; build and testing).

## 1. Goal

A landing page that makes a visitor understand what the studio makes, try the real renderer without an
account, and reach either a free first draft or the pricing page — without a single invented number, face
or logo on it. Audience: content creators, marketers and agencies who make short videos for money.

A studio without accounts (`SUPABASE_URL` unset) is unchanged: the landing page does not exist there.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The landing page lives in the studio's Next app, in a `(marketing)` route group with its own root layout; the studio's pages move into `(studio)` | one deploy; the hero uses the studio's real player and catalogue; two root layouts mean no style, font or script of one side reaches the other |
| D2 | A signed-out visitor at `/` sees the landing page (the proxy rewrites `/` to `/welcome`); a signed-in user sees the video list at the same address | the address people share is the bare domain |
| D3 | Light theme, "House lights up": warm paper, ink, one vermilion signal; the studio stays dark | every AI-video site is dark with a neon gradient; the videos should be the only saturated colour |
| D4 | Fraunces (display), Schibsted Grotesk (text), IBM Plex Mono (every number); files in the repository with their licences, loaded with `next/font/local` | no third-party request, no layout shift; not the template defaults |
| D5 | The hero is the studio's real player on finished sample videos; visitors change only what a re-render changes for free | it is the real engine, instant, and costs nothing per visitor; generation is neither instant nor free |
| D6 | A new account may get a small welcome credit (`settings.welcome_credit_usd`, default 0 = off; $0.05 when on), once, with a daily ceiling for all accounts together | a free first script draft (about $0.006) without a way to make the owner pay for a flood of sign-ups |
| D7 | Claims are evidence-led: our costs come from real runs' ledgers; a competitor's price carries its source and the date it was checked, and disappears when older than 90 days; the headline states a multiple only if those numbers support it | "10x" could not be confirmed when this was designed |
| D8 | Proof is real videos with their real receipts. No testimonials, logos, user counts or avatars until real ones exist | there are no customers yet |
| D9 | Motion with the `motion` package (Framer Motion), loaded on marketing pages only; springs with three named settings; everything reduces to fades under `prefers-reduced-motion`; no scroll-jacking | one character of movement; the studio's bundle is untouched |
| D10 | No tracking script in this phase; buttons carry stable `data-cta` names | analytics can be attached later without touching the design |

## 3. Design system

### 3.1 Colour (tokens of the marketing side only)

| Token | Value | Used for |
|---|---|---|
| `paper` | `#F4EFE6` | the page |
| `ink` | `#14110F` | text; primary buttons (paper text on ink) |
| `stage` | `#0E0D0B` | the dark band the player sits on |
| `signal` | `#E8420A` | one accent, as a tally light: large type, rules, the live dot. Never body text |
| `graphite` | `#5B5F66` | secondary text |
| `hairline` | ink at 12 % | rules and borders |

No gradients, no glow. Ink on paper is 16:1; graphite on paper passes AA for body text; `signal` is used at
sizes and weights where 3:1 suffices.

### 3.2 Type

- **Fraunces** (variable): display. Very large (`clamp(3rem, 9vw, 8.5rem)`), tight leading (0.92–1.0),
  optical size at its maximum. No word of a headline is set apart in italic or colour.
- **Schibsted Grotesk** (variable): text and interface, 17–19 px body, 1.5 leading, measure ≤ 68 characters.
- **IBM Plex Mono**: prices, timecodes, receipts; tabular figures. No capitalised labels above headings.

### 3.3 Signature devices

- **The receipt:** a narrow mono slip beside a showcase video listing what it cost, line by line, from the
  run's ledger, with its total.
- **Print and film marks:** crop marks at the corners of the Stage, a running timecode and frame counter.
  Numbers mark only what is a real sequence (the stages of making a video).
- **Three depth layers:** paper; glass (backdrop blur, a hairline edge, fine grain) for controls over
  video; the film itself.

### 3.4 Motion

Three springs — `snap` (controls), `settle` (panels, the player docking), `drift` (ambient parallax) — and
nothing else. The hero player scrubs with scroll, then docks. Under `prefers-reduced-motion`: opacity only.

### 3.5 Banned

Gradient blobs, glow, emoji or stock icons, three-column icon grids, fake dashboards, invented avatars,
logos, numbers or quotes; an italic or coloured accent word in a headline; capitalised eyebrow labels;
arrows appended to buttons; meta strings joined with middle dots.

*Amended 2026-10-08 after building Task 1:* the cream paper, serif display and vermilion accent the owner
approved are, taken together, a common machine-generated look. They stay as approved; what is removed are
the details above that mark that look, so that what distinguishes the page is what belongs to this product:
the 9:16 Stage, the film leader and timecode, and the real receipts.

### 3.6 Budget

The hero paints a still poster first and mounts the player after it; largest contentful paint under 2.5 s
on a mid-range phone; no layout shift from fonts.

## 4. Routing and isolation

```
web/app/(studio)/layout.tsx        the present root layout (dark, globals.css, the studio header)
web/app/(studio)/…                 every present page: /, /new, /runs, /brand-kits, /account, /login, /signup, /reset
web/app/(marketing)/layout.tsx     html + body with the three fonts and site.css; nav and footer
web/app/(marketing)/welcome/       the landing page
web/app/(marketing)/pricing/       /pricing, in the light theme (task 7)
web/app/api/…, web/app/auth/…      route handlers, outside both groups, unchanged
```

- Two root layouts: going from one side to the other is a full page load, on purpose.
- `web/proxy.ts`: in a studio with accounts, a request for `/` without a session is **rewritten** to
  `/welcome` (the address stays `/`). Every other page without a session still redirects to `/login` with
  `next`. `/welcome` joins `PUBLIC_PAGES`.
- `/welcome` answers 404 in a studio without accounts.
- `site.css` holds the marketing tokens; `globals.css` stays the studio's. Neither layout imports the other's.

## 5. The page

| # | Block | Job |
|---|---|---|
| 1 | Nav | wordmark, Pricing, Sign in, "Make a free draft" |
| 2 | Hero | headline, one supporting line, the two calls to action, the Stage with the live player |
| 3 | How a video is made | a horizontal film strip of the real stages (topic, script, voice, pictures, cut), each with the artefact of the video playing above |
| 4 | Features as demonstrations | Brand Kit, Hook, Auto-SFX, the queue: each a control on a real video |
| 5 | Showcase with receipts | the real videos with their cost slips |
| 6 | Calculator | what a month costs here; competitors where the data is fresh |
| 7 | Plans | read from the live catalogue; links to `/pricing` |
| 8 | Honest FAQ | what expires, refunds, what the product cannot do |
| 9 | Closing call to action, footer | links to terms and privacy |

**Funnel.** Primary: "Make a free draft" → `/signup?next=/new?topic=…` (the topic typed in the hero is
carried through; `safeNext` already keeps a path with a query). Secondary: "See pricing" → `/pricing` →
Checkout (3.4). With welcome credit off, the primary button reads "Create an account".

## 6. The live hero

- Mounts `StudioPlayer` (the paid render's own composition) on a showcase video's props, with a resolver
  that maps published paths to `/showcase/<slug>/…`.
- Controls change render props only: caption style, look, transition, hook title, brand (watermark,
  colour, font), music and effects layers. The label says what it is: the real renderer; new pictures
  take minutes and are what the free draft is for.
- Poster first; the player is mounted after first paint and only when the Stage is in view.

### 6.1 Showcase export

`npm run make:showcase -- <runId> --slug <name>` (free: reads a finished run, calls no provider) writes to
`web/public/showcase/<slug>/`: the published media, re-encoded small; `props.json` (the render props);
`poster.jpg`; `receipt.json` — the ledger grouped as script, voice, pictures, clips, with the total and the
engine. About three videos are committed, one per engine in use.

## 7. The calculator

- Input: videos per month. Output: the plan that fits, the credit it grants, the cost per video.
- Our side: the live catalogue (`catalogue()`) and the measured cost of the showcase runs.
- `web/content/comparison.json`: `[{ name, pricePerVideoUsd, basis, source, checkedOn }]`. An entry
  without a source, or checked more than 90 days ago, is not shown. The page prints "as of <date>".
- The arithmetic is a pure function with tests; the page never states a multiple the function did not compute.

## 8. Welcome credit

- `settings`: `welcome_credit_usd` (default 0), `welcome_daily_cap_usd` (default 5).
- The sign-up trigger grants it once per account when on and when today's total of welcome grants stays
  within the cap; a `grant` ledger row with the note `welcome`. Over the cap: the account is created with 0.
- Permanent credit (not plan credit). An account cannot sign in until its email is confirmed (production).
- The tenancy migration is still unapplied to any hosted database, so it is edited in place.

## 9. Testing

- **Unit:** calculator arithmetic and the staleness rule; receipt export from a ledger; welcome credit in
  the database (once, the cap, off by default).
- **Browser:** the landing page for a signed-out visitor at `/`; the video list for a signed-in one; both
  calls to action reach their destinations with the topic carried; every hero control changes the frame;
  reduced motion; no console errors; in a studio without accounts `/` is unchanged and `/welcome` is 404;
  the paper background on one side and the studio's dark one on the other (no leak either way).
- **Looks and speed:** screenshots at phone, tablet and desktop widths, reviewed; the paint budget measured.

## 10. Tasks

1. Route groups, the marketing layout, fonts and tokens; the studio proven unchanged.
2. The showcase export script and the exported videos.
3. The hero: player, glass controls, poster-first loading.
4. Film strip, feature demonstrations, showcase with receipts.
5. The calculator and the comparison data.
6. Welcome credit and the topic carried through sign-up.
7. `/pricing` in the light theme, FAQ, footer, final copy.

## 11. Needed from the owner

- Which runs to showcase (or new ones, about $1.35 each on fal, with a click).
- Confirmation that the ElevenLabs voice and the example music bed may be shown on a public page.
- Approval of the researched competitor figures before any headline uses them.
- The text of the terms and privacy pages (placeholders until then; needed before real money).
- Approval of the final headline and FAQ.

## 12. Definition of Done

1. A signed-out visitor at `/` sees the landing page; nothing of its styling reaches the studio, and the reverse.
2. The hero plays a real video in the real renderer and its controls change it instantly.
3. Every number on the page is computed from a ledger, the live catalogue, or a dated, sourced entry.
4. Both calls to action work end to end; a topic typed in the hero is the new account's first draft.
5. Without accounts the studio is exactly as before; all earlier tests pass.

## 13. What Was Built, Found and Changed (2026-10-08)

Built as a prototype in a scratch clone, one commit per task, and brought onto `main` as those commits (the
work holds fonts, clips and audio, which a text plan cannot carry). Reviewed as a whole branch; the findings
are fixed or recorded below. Where this section and an earlier one disagree, this one describes what is there.

**Decided by the owner on the way**

- Showcases: runs made on the studio's own GPU (the clockmaker, and a new product-photography video with the
  brand kit, $0.23) and one made with hosted models (the robot painter). Voice and music cleared for public use.
- Headline: "A finished short video for about what others charge for the clips." — shown only while
  `clipsClaimHolds` is true; otherwise "Type a topic. Get a finished short video."
- The competitor rows (Luma Ray 3.14 at 540p and 720p on Plus; Runway Gen-4 Turbo and Gen-4.5 on Standard),
  read from their pricing pages on 2026-10-08, approved as built. **"10x" was not borne out**: against Runway
  it is about 4.5x and 9x for the clips alone; against Luma at 540p the prices are about equal.
- The calculator recommends the cheapest way to buy, including where that is a top-up rather than a plan.
- The refund answer says how refunds behave; the terms and privacy pages say they are not written yet.

**Where the built design differs from §1–§12**

- §3.4 motion: one spring ("snap") for controls, a fade as the player takes the poster's place. No scroll
  scrub and no docking: the controls sit under the Stage as a desk the whole width of the page.
- §4: `PUBLIC_PAGES` also holds `showcase` (the videos' own files), `terms` and `privacy`.
- §5: the hero's call to action is a field ("What is your video about?") and one button; "See pricing" is a
  link under it. The features are shown on a second player (the branded video), fetched when reached.
- §6: every look is computed at export (`src/deploy/showcase-looks.ts`, by `previewProps`) and the browser
  only chooses (`web/lib/site/restyle.ts`). Caption styles are labelled by what they look like, not by the
  people the pipeline names them after. Bundled fonts and sounds are published once, in `_shared`.
- §6.1: also `looks.json` and `making.json` (script lines, a picture per scene, the voice's waveform).
- §7: a comparison entry is `{ name, plan, planUsdPerMonth, creditsPerMonth, model, resolution,
  creditsPerSecond, source, checkedOn }`; the price per second is worked out from it. What is compared is the
  seconds of generated clips in one of our videos, since clips are all the others sell.
- §8: welcome credit is granted when the address is **confirmed**, not at sign-up (unconfirmed sign-ups could
  otherwise use up the day's cap). The page asks `welcome_offer()` and promises a free draft only while a new
  account would be given at least a draft's hold.
- New: `STUDIO_ENGINE` (the worker's `PROVIDER_MODE`, passed to the web app by setup) says which way the
  studio makes pictures by default; the calculator starts there and the headline is held to it.

**Found by the review and fixed**

- A unit test held two real GPU endpoint ids, and an unknown own-GPU model would have been published with
  its endpoint id. The ids were removed from the unpushed commits; `engineName` never shows an endpoint.
- The pricing page said plans give "a better rate"; with the default prices Starter's rate is worse than the
  $25 top-up's. It is now said only when every plan beats every top-up.
- The quote was not always the cheapest (it never mixed top-ups). It now weighs every combination of at
  most one plan with any top-ups, and a test compares it with a brute-force search.
- Figures typed into copy (the number of videos, their length, the opening title's seconds, the scene limit,
  the clip resolution) are now taken from the data and the code.
- A long non-Latin topic could exceed what sign-up accepts as a destination: the hero carries 200 characters.
- The export is all-or-nothing, refuses a wide run, keeps a PNG logo's transparency, and publishes no run id.
- Freshness is by the calendar day. The welcome grant logs a warning when it fails and never waits more
  than two seconds for its lock. Reduced motion is honoured by the springs as well.

**Rulings and known limits**

- The browser suite turns welcome credit on for the whole local database for one test, and resets it before
  and after: it must run on its own. Cost if wrong: other suites' new users get five cents for a moment.
- The offer is read when the page is viewed (and cached a minute); the grant happens at confirmation. If the
  day's cap is reached in between, a visitor promised a free draft gets none.
- A hundred confirmed throwaway accounts can take a day's cap; the page then promises nothing.
- Both players loop while the page is open, do not pause off screen, and can both be unmuted.
- With two root layouts an address that matches nothing shows Next's plain "not found", not the studio's frame.
- Our own-GPU cost is measured GPU seconds at a configured rate: cold starts and idle time are not in a receipt.
- After 90 days without re-reading the other companies' prices, the table and the comparing headline go,
  silently and by design; nothing warns beforehand.

**Verification** is recorded in the commit that closes the review.

## 14. One site, one look (owner's ruling, 2026-10-10)

The owner, on seeing the landing page and the studio side by side: they look like two different websites, and
both look machine-made. §3 (the look) and the two-looks half of §4 are replaced by this section. §3.5's list of
banned details stands and is extended below; §3.6's budget stands.

**What was wrong.** The landing page was cream paper, a high-contrast serif and a vermilion accent; the studio
was near-black with one bright accent and everything in identical rounded cards with small capitalised labels.
Each is the look a generated page most often has (§3.5's own amendment had already said so of the first), and
they shared nothing: no typeface, no colour, no header.

**The idea.** A script, marked up. The product reads a script aloud and puts a highlight on each word as it is
spoken; the site is drawn the same way.

- **Colour** (`web/app/theme.css`): blue ink `#17227a` on white paper `#fafaf7`; a stronger blue `#2a3be6` for
  what is pressed; highlighter yellow `#ffe03a`; black only for a video. Yellow is never a text colour and never
  decoration: it is on the one thing that is "on" — the choice that is chosen, the job that is working, the
  video that is selected. The only dark thing on any page is a video.
- **Type:** one family, Archivo (a variable face with a width axis; one file, its licence beside it). Text at
  its normal width; headings narrow and heavy, as a caption is set on a video. No serif, no monospace: figures
  are the same face with tabular numerals.
- **The one movement nobody asked for:** the landing headline is read out once, the highlighter on each word
  in turn, and then put down (`Spoken`). Nothing else on a page moves by itself except a video.
- **Structure instead of boxes:** a part of a page is a heading over an ink rule (`Panel`), not a card. The
  steps of making a video are a timeline: one track for each step, drawn against the video's own length, so a
  scene's words, its stretch of the voice and its picture stand under one another (`MakingStrip`).
- **One layout** (`web/app/layout.tsx`): one header and one foot for every page. What the header offers
  depends on who is looking, not on which page it is. The account forms stand beside a frame of a real video
  with its cost. `(marketing)` and `(studio)` remain as folders; they no longer have looks of their own, and
  going from one to the other is no longer a full page load.
- **Banned, in addition to §3.5:** cream paper with a serif and a warm accent; near-black with one bright
  accent; a card around every part; small capitalised labels; a monospace face for figures; a dash or a middle
  dot joining fragments of a label ("Generate video, up to $0.31", not "Generate video — up to $0.31").

**Sound** (same day): a video on the landing page has its sound on. A browser allows no sound before the
visitor has touched the page, so until then it plays silently, and with their first click or key anywhere it
is heard from where it had got to; there is no button for it. A video that leaves the window stops, so two
are never heard at once. (This replaces the "Sound on" button of earlier the same day.)

**Tests.** The accounts browser suite now holds the landing page, the account form and the studio to one
background, one typeface for headings and text, and one wordmark, where it used to hold them apart. The phone
budget test caught the new headings jumping when the face arrived (a layout shift of 0.21): headings have a
stand-in face shrunk to the narrow width (0.001 after).

**Rulings and parked**

- The typeface file is fetched twice (once declared for text, once for headings with the narrow stand-in):
  about 115 KB more on a first visit. Parked: one declaration with a hand-written stand-in for both.
- Not looked at in Safari or Firefox; every check here was in Chromium. Parked with the owner's own look.
- The run list shows a video's picture in a wide frame although most videos are upright. Parked.
- `/terms` and `/privacy` still say that they are not written.

## 15. The storyboard (owner's choice, 2026-10-10)

The owner, on seeing §14's look: better can be done, and a third-party design skill may be used. §14's look
(blue ink, yellow highlighter, one narrow face) is replaced by this section. §14's one-site rule, its sound
rule, its lists of banned details and its tests stand.

**How it was chosen.** Three skills were looked at. *Impeccable* (Apache 2.0) was used: it is written for
redesigning a product that exists, on both a page that persuades and screens that are worked in, and it asks
for a visual world taken from the audience's own before any code. *UI/UX Pro Max* picks from tables of styles
and palettes by industry, which is how a template is arrived at; *Taste Skill* is a set of dials for one
premium look. Impeccable's files were read from a clone and followed by hand: its launcher downloads a program
and runs it, and that was not done. Four worlds were put to the owner (a video feed, broadcast colour bars, a
storyboard, a cinema's box office) with how strongly things should move; the owner chose **the storyboard**
and **measured** movement.

**The world** (`web/app/theme.css`, `web/components/Sketch.tsx`): where a video begins, on a drawing desk.

- **Paper** `#fafaf7`. **Graphite** `#25252b` for everything printed: text, labels, controls, solid buttons.
- **Non-photo blue**, the animator's construction pencil: every rule (`hairline`), the loose first line of
  every drawn frame, and as shading (`marker`) behind the thing that is on. A deeper **blue pencil** `#1c6ea4`
  (`signal`) for focus, links and switches.
- **Red pencil** `#c92c2c` (`pencil`): what is noted on a board. What a scene is, how long it runs, what a
  thing cost. In the hand (`.note`), never for an error (errors are `bad`, on a tint, in the printed face).
- **Two voices.** What is written on the board is in a hand (Covered By Your Grace, a file with its licence):
  titles (`.display`), the wordmark, notes. What is printed on it is Archivo: text, controls, and the headings
  of a form's parts (`.printed`).
- **What is drawn is drawn twice** (`Frame`, `Arrow`, `Underline`): loosely in blue, then over it in pencil;
  neither line is straight, and the unevenness is worked out from a number so that server and browser draw the
  same. A part of a page begins under a pencil rule (`.ruled`).
- **The one movement nobody asked for:** when the landing page is first shown, the board's frames are drawn
  one after another and its notes are written. Nothing else moves by itself except a video.

**The landing page's first screen is a board:** the page's words; the video's own scenes as numbered panels,
each with its line and a note; arrows from one to the next; and the panel that moves, the playing video. A
click on a panel plays the video from that scene. On a phone the video comes before the panels (found by the
phone test: under them it was never reached, and never started).

**The studio** takes from the world only its type, its palette and one move: a run's scenes are panels of a
board (the scene's own picture in a drawn frame; a scene that carries on from the one before has none), and
the videos in the list and the player are framed the same way. Controls are ordinary controls.

**Rulings and parked**

- Looked at in Chromium only (desktop and a phone's width), on the landing page, the account form, the new
  video form, the list and a run. Parked: Safari and Firefox; the account, pricing and brand kit pages.
- The hand at small sizes (a note beside a scene) is at the edge of comfortable reading. Parked: the owner's
  eye on it.
- The landing page shows scenes of videos made before the looks of phase 2.2 §12 existed; no picture of the
  fourteen looks is on it, because none has been made (a paid check, still waiting for the owner's click).

## 16. The feed (owner's choice, 2026-10-10)

The owner asked to see the directions that were not chosen in §15 before deciding. The three were mocked up
on one page with the studio's real videos and figures (`.superpowers/design-directions/`, not in the
repository), beside the storyboard as built. The owner chose **the feed**. §15's look is replaced by this
section; §14's one-site rule, its sound rule and its tests stand, and so does §15's account of how the skill
was chosen.

**The world** (`web/app/theme.css`): where these videos are watched.

- **The screen at night:** the page is black, and the light on it comes from the videos. What stands on it (a
  row, a field, a card of a video's facts) is a step lighter (`sheet`, `wash`); a part of a page begins under a
  thin line of light (`.ruled`).
- **The captions' own face:** Montserrat, the face the studio's default captions are set in (one file, its
  licence beside it). Text is its medium weight; a title is its heaviest, in capitals, as a caption is
  (`.display`); a part's heading is the same weight in ordinary letters (`.printed`).
- **Caption yellow** `#ffe500` is on the thing that is "being spoken": the word the title rests on, the choice
  that is chosen, the action to take. Text on it is black.
- **Rounded as on a phone:** videos and cards have a phone's corners; buttons, choices and badges are pills.
- **The one movement nobody asked for:** the landing title is spoken once, yellow on each word in turn, and
  comes to rest on "finished" (`Spoken`).

**The landing page's first screen** is a title across the page, then the words and the place to type a topic
(a bar like the one a feed has for a comment) beside the videos as a feed shows them: one in front and
playing, the others dimmed at its sides, where a click brings one to the front. Under them the playing video's
scenes are a row of cards; a click on one plays the video from that scene.

**The studio** takes the same palette, face and corners; its controls are ordinary controls. A run's scenes
are rows with the scene's own picture; the look chosen for a new video has a yellow edge.

**Rulings and parked**

- This is the look §14's own list calls a common machine-made one (near-black with one bright accent). Ruling:
  the owner chose it over three others, having seen all four built or mocked; what keeps it this product's is
  that the yellow and the face are the captions' own and the layout is a feed's.
- Looked at in Chromium only (desktop and a phone's width), on the landing page, the sign-in form, the new
  video form and a run. Parked: Safari and Firefox; the video list, account, pricing and brand kit pages.
- A title handed from the server to the hero and set directly among its other children made React warn about
  a list without keys; it is rendered in an element of its own.
- The typeface file is still fetched twice (text, and titles with their wider stand-in). Parked, as in §14.
