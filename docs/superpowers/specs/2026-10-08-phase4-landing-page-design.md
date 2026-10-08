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
  optical size at its maximum; the italic for the one emphasised word of a headline.
- **Schibsted Grotesk** (variable): text and interface, 17–19 px body, 1.5 leading, measure ≤ 68 characters.
- **IBM Plex Mono**: prices, timecodes, receipts, labels in small capitals; tabular figures.

### 3.3 Signature devices

- **The receipt:** a narrow mono slip beside a showcase video listing what it cost, line by line, from the
  run's ledger, with its total.
- **Print and film marks:** crop marks at the corners of the Stage, registration marks, a running timecode
  and frame counter; section numbers set like folios.
- **Three depth layers:** paper; glass (backdrop blur, a hairline edge, fine grain) for controls over
  video; the film itself.

### 3.4 Motion

Three springs — `snap` (controls), `settle` (panels, the player docking), `drift` (ambient parallax) — and
nothing else. The hero player scrubs with scroll, then docks. Under `prefers-reduced-motion`: opacity only.

### 3.5 Banned

Gradient blobs, glow, emoji or stock icons, three-column icon grids, fake dashboards, invented avatars,
logos, numbers or quotes.

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
