# The Studio — a private view for the people who run this thing

**Every phase is built, verified and deployed (2026-07-30/31).**

This page is a roundup first and a reference second. Everything below the
divider is detail — the design reasoning (§1–§5), the build record with the bugs
worth not repeating (§6), and the open brainstorm (§10). Section numbers are
referenced from `server.js` and four other docs, so they stay put.

---

## At a glance

### Shipped

| Phase | What it does | Detail |
| --- | --- | --- |
| **1b — durable storage** | One `DATA_DIR`, atomic writes, flush on `SIGTERM`, and a volume that can *prove* it persisted. Fixed the bug that silently reset production every deploy. | [§6](#phase-1b-durable-storage-done-both-halves-2026-07-30) |
| **1 — the gate** | Password-gated `/studio`. Unset password ⇒ the routes do not exist. Stateless signed-cookie sessions, rate-limited login. | [§6](#phase-1-the-gate-built-2026-07-30) |
| **2 — content dashboard** | What is in the archive: shows, episodes, hours, category mix, air-date histogram, thinnest coverage, coverage meters, sortable table of every feed. | [§6](#phase-2-the-content-dashboard-built-2026-07-30) |
| **2.5 — full width** | 100rem, four columns at 1440px. Page height 6,650px → 2,480px. | [§6](#phase-25-full-width-2026-07-31) |
| **3 — operational health** | Feed failures **named**, per-feed staleness, per-host upstream latency from real traffic, process and cache stats. | [§6](#phase-3-operational-health-built-2026-07-31) |
| **4 — actions** | Re-check feeds, refresh the directory, re-probe the stream, drop a cache. Idempotent, cooled down, CSRF-guarded, logged. | [§6](#phase-4-actions-built-2026-07-31) |
| **5 — listener analytics** | **Time listened** per show (the headline), plus plays, live tune-ins, page views, searches, shares. No identifier of any kind. | [§6](#phase-5-listener-analytics-built-2026-07-31) |
| **5.1 — reach** | Does the station reach past its own signal? Page views split local / rest of US / international, from the **browser's timezone** — never from an IP. | [§6](#phase-51--reach-without-geolocation--built-2026-08-01) |
| **5.2 — windows, history, export** | One 7d/30d/90d/year/all-time picker for every listening figure, per-show month-by-month drill-down, this-month-vs-last, CSV export. Presentation only — nothing new collected. | [§6](#phase-52--windows-history-comparison-export--built-2026-08-03) |

### Next up — nothing committed

Ranked by value ÷ effort. Full reasoning and the rest of the menu in [§10](#10-brainstorm-where-this-could-go-next).

| | Candidate | Why it is worth doing | Effort |
| --- | --- | --- | --- |
| 1 | **Inventory snapshots** | The only one that gets *worse* the longer it waits — every day without it is history that cannot be recovered. Nothing today records what the archive looked like last week. | S |
| 2 | **Completion rate** | Turns the dashboard from a description into a judgement: people open this show and leave, they sit through that one. Needs no new collection. | S |
| 3 | **Alerting (webhook)** | A dashboard only helps if someone opens it. The volume bug ran for weeks because nothing shouted. | S |
| 4 | **Content QA panel** | Turns the coverage meters from a number into a to-do list. | S |
| 5 | **Shows nobody played** | The actionable inverse of "most listened". | XS |

**Before proposing anything:** [§10.1](#101-what-this-design-makes-impossible-read-before-proposing) lists what this
design makes *arithmetically* impossible — unique listeners, returning-vs-new,
per-person session length. They need identity, and there is none.

### Standing decisions

- **`/studio`, not `/admin`** — radio-native, and not a word that tells a scanner it found something.
- **No listener identity, ever** — no cookie, no session, no fingerprint, no stored or hashed IP.
- **Plain JSON on a mounted volume, no database** — a volunteer at another station can read the file.
- **This repo is a template** — a per-station difference is a setting, never a code edit.
- **Local proves the code path; only a redeploy proves the storage** — [§5.1](#51-local-is-not-production-and-local-never-fails), and it is not optional politeness.

---

# Detail

## 1. What we are building

A password-gated area at `/studio` whose first tenant is a stats dashboard.
Same visual language as the app (same tokens, same dark/light control, same
type), but its own page — not a mode of the listener app.

Why a separate page rather than a panel inside `app.js`:

- `app.js` is 3,098 lines and owns two `<audio>` elements, a shared player bar,
  a virtualised list and a touch-lock system that took a documented war to get
  right ([touch-dev.md](touch-dev.md), [big-audio-bug.md](big-audio-bug.md)).
  Adding an authenticated dashboard to it puts admin code in the blast radius of
  every playback change, and playback changes in the blast radius of the
  dashboard. There is no shared behaviour to justify that.
- Every listener would download the dashboard. The listener bundle is already
  145 KB of JS.
- The gate is cleaner when the gated thing is a different document. See §3.4.

The two pages **share `styles.css` and `theme-boot.js`** and nothing else. The
tokens, the theme toggle and the first-paint theme application come for free;
the studio adds `studio.css` for its own layout.

---

## 2. Audit — what is actually here

### 2.1 Server shape and the six constraints it imposes

`server.js` is 1,511 lines, zero dependencies, no build step. Six facts in it
directly constrain this feature. Each has a required action.

| # | Fact in the code | Consequence | Action |
| --- | --- | --- | --- |
| 1 | [server.js:1393](../server.js#L1393) rejects everything that isn't `GET`/`HEAD` with a 405. | A login form cannot post. | Relax narrowly: allow `POST` **only** for the studio's own auth routes; keep the blanket 405 for every other path. Not a global `if (method === 'POST')`. |
| 2 | [server.js:1220](../server.js#L1220) — `notFound()` falls back to `index.html` for any extension-less path. | `/studio` today renders the listener app. There is no 404 for word-shaped URLs. | Register the studio routes **before** `serveStatic`. When the feature is off, deliberately *keep* falling through — `/studio` then looks exactly like `/anything-else`, which is better camouflage than a 404. |
| 3 | [server.js:1372](../server.js#L1372) — `serveStatic` serves anything under `public/`. | Putting `studio.html` in `public/` publishes it. A gate in front of `/studio` would be walked around by `/studio.html`. | The studio's HTML lives in a **new top-level `admin/` directory**, outside `PUBLIC_DIR`, and is only ever read by an authenticated route. Its CSS/JS can live in `public/` (they are inert without data). |
| 4 | [server.js:1245](../server.js#L1245) — `stampAssets()` version-stamps exactly three filenames by literal string replacement. | A new `studio.js` gets no `?v=` stamp, so it is cached under a stable name and can go stale — the single worst failure mode in this repo (CLAUDE.md §1). | Generalise `stampAssets` to a regex over all local `/x.css` and `/x.js` references, or add the studio files explicitly. **Non-negotiable, and it belongs in Phase 1, not later.** |
| 5 | [server.js:1185](../server.js#L1185) — CSP is `script-src 'self'; style-src 'self'`, no `unsafe-inline`. | No CDN chart library, no inline `<script>`, no `<style>` block, no `style="..."` attributes in markup. | Decided in §4. Note the CSSOM escape hatch is real and already used: `el.style.setProperty('--pct', …)` at [app.js:655](../public/app.js#L655) works fine under this CSP — only *parsed* inline styles are blocked. Charts can be driven by JS-set custom properties. |
| 6 | [server.js:1381](../server.js#L1381) — `sendJson` sets `public, max-age=N` whenever `cacheSeconds` is passed. | An authenticated response cached by Traefik or a browser back-button is a leak. | Studio responses use `Cache-Control: private, no-store` **and** `Vary: Cookie`. Never pass `cacheSeconds` on a studio route. |

Two more worth knowing, not blocking:

- `securityHeaders()` is applied uniformly, including `frame-src
  https://docs.pacifica.org` — needed by the donate modal, irrelevant to the
  studio. Tightening it per-route is a nice-to-have, not a phase.
- Behind Coolify the peer address is Traefik, so rate-limiting by
  `req.socket.remoteAddress` would bucket the entire internet together. Use
  `X-Forwarded-For`'s first hop, and say in a comment that this is only
  trustworthy *because* we are always behind that proxy.

### 2.2 Data we already have (the whole of Phase 2 is free)

Measured on today's `data/` (2026-07-30):

| Source | Holds | Useful for |
| --- | --- | --- |
| `data/feeds.json` (342 KB) | **122 feeds, 471 episodes**, each with `mp3`, `bytes`, `durationSec`, `dt`, `title`, `desc`, `category`; per-feed `lastModified` / `fetchedAt`; channel title/desc/author/image | Nearly every content stat. **547 hours / 31.4 GB** of audio, 7 categories, air-date range 2026-05-20 → 2026-07-30 |
| `data/programs.json` (124 KB) | **149 programs** — title, host, description | Directory coverage: which of the 149 known programs have feeds (122) and which don't |
| `data/showinfo.json` (68 KB) | **115 harvested records** — name, dj, desc, `seen` timestamp | Harvest coverage and freshness; which shows the on-air poll has never met |
| `storageDiag` / `feedsDiag` ([server.js:690](../server.js#L690), [server.js:226](../server.js#L226)) | writability, records-on-disk-at-boot, last harvest, 304 count, failure count | The health panel, including the production volume question |

Notable shape facts that should drive the design, not be discovered during it:

- **Max 5 items per feed.** Upstream retention is a short rolling window, so
  "episodes" is a *current inventory*, not a growing archive. Charts must not
  imply accumulation. A "what's in the window right now" framing is honest;
  a cumulative line chart would be a lie.
- **Category mix is lopsided** — Public Affairs 263, Arts 70, Music 61, Health
  40, Sci/Eco/Tech 19, News 17, Special 1. Any donut or bar needs to survive a
  56% first slice and a 0.2% last one without looking broken.
- **122 feeds vs 149 programs vs 115 harvested records.** Those three numbers
  disagreeing is itself the most interesting operational stat on the page.

### 2.3 What did not exist when this was written *(historical — Phase 5 changed it)*

**No usage data of any kind.** There is no request log, no counter, no
`sendBeacon`, no analytics of any sort anywhere in `server.js` or `app.js`
(verified by grep). Nothing records a page view, a play, a search or a share.

This is worth stating plainly because "stats dashboard" usually means listener
numbers, and today there is not one byte of that to draw. Phases 2 and 3 are
built entirely from the archive's own state. Listener analytics is Phase 5, is
a from-scratch build, and has a hard prerequisite (§5.4).

### 2.4 Test infrastructure that already exists

`test/` holds six suites, including a real headless-Chrome CDP harness
(`test/live-stream/` with `cdp.js`, a fake station, `run.sh` / `run.sh
--strict`). The studio does not need a new harness — it needs new suites in the
existing one. CLAUDE.md §3a applies with full force: **assert the effect**. "Is
the cookie set?" is not the question; "does `/api/studio/stats` return 401 to a
client that has not logged in?" is.

---

## 3. Auth design

One shared password, in a Coolify environment variable. That is the brief, and
it is a reasonable fit for a handful of trusted station people. It is also the
weakest common auth model there is, so the design should be honest about what it
protects: this keeps the general public and casual scanners out of operational
data. It is not a system for revoking one person's access.

### 3.1 Environment variables

| Var | Required | Meaning |
| --- | --- | --- |
| `STUDIO_PASSWORD` | to enable | The shared password. **Unset ⇒ the feature does not exist** — routes fall through to the normal SPA fallback (constraint #2), so the deployment is indistinguishable from one that never had a studio. This is also the safe default for anyone who forks the repo. |
| `STUDIO_SECRET` | no | HMAC key for session cookies. Defaults to a key *derived from the password*, which buys a useful property for free: **rotating the password invalidates every live session.** Set it explicitly only if you want sessions to survive a password change. |
| `STUDIO_SESSION_HOURS` | no | Cookie lifetime, default 12. Long enough for a working day, short enough that a forgotten laptop expires. |

Fail loudly at boot on a bad configuration (password shorter than 12 chars, say)
rather than silently accepting a weak one. Storage configuration is the fourth
variable, `DATA_DIR` — see §5.2, where it replaces three existing ones.

### 3.2 Session: a stateless signed cookie

`POST /api/studio/login` with the password → compare using
`crypto.timingSafeEqual` over SHA-256 digests of both sides (equal length, no
early return, no leak of the password's length) → set:

```
Set-Cookie: studio=<exp>.<hmac>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=…
```

where `hmac = HMAC-SHA256(key, exp)`. Verification is a recomputation — **no
server-side session store**. That matters here specifically: this repo's
production storage is unreliable (CLAUDE.md §4), and a session table on a volume
that may not be mounted would log everyone out at unpredictable times. Stateless
sessions also survive a restart, which the harvest caches do not.

`Secure` on the cookie means the studio does not work over plain HTTP.
`http://localhost:8080` is a secure context so local dev is fine, and the flag
also keys off `X-Forwarded-Proto` in production.

`POST /api/studio/logout` clears the cookie. There is no way to invalidate one
session remotely; rotating `STUDIO_PASSWORD` invalidates all of them, and that
is the documented answer.

### 3.3 Rate limiting

A single shared password is guessable at volume, so the login route needs a
brake: an in-memory `Map` of failed attempts keyed by the first `X-Forwarded-For`
hop, with exponential backoff (1s, 2s, 4s… capped) and a hard lock after N
failures within a window. In-memory is correct — it resets on restart, which is
acceptable, and it adds no storage dependency. Cap the map's size so it cannot
be grown into a memory-exhaustion vector.

The login response must not distinguish "wrong password" from "rate limited" in
a way that helps; a single `401` with a `Retry-After` is enough.

### 3.4 Route map

| Route | Method | Auth | Returns |
| --- | --- | --- | --- |
| `/studio` | GET | none | The login page (from `admin/`) if logged out; the dashboard shell if logged in |
| `/api/studio/login` | POST | none, rate-limited | 204 + `Set-Cookie`, or 401 |
| `/api/studio/logout` | POST | cookie | 204 + cleared cookie |
| `/api/studio/stats` | GET | cookie | Content stats JSON (Phase 2). `?days=7\|30\|90\|365\|all` sets the window for the per-show plays/listened columns (Phase 5.2) |
| `/api/studio/health` | GET | cookie | Operational stats JSON (Phase 3) |
| `/api/studio/usage` | GET | cookie | Listening figures (Phase 5). Same `?days=` menu as stats (Phase 5.2) |
| `/api/studio/showhistory` | GET | cookie | One show's plays/listened per month, all recorded months. `?slug=` is shape-checked, 400 otherwise (Phase 5.2) |
| `/api/studio/action` | POST | cookie **+ CSRF header** | Runs one maintenance action (Phase 4) |
| `/api/ev` | POST | **none** | The public usage beacon. Carries no identity, answers `204` to everything, unregistered when `USAGE_TRACKING=off` |

Everything under `/api/studio/*` returns **401 with no body detail** when the
cookie is missing or fails verification. The dashboard's JS treats any 401 as
"reload to the login page".

---

## 4. Charts: a package, or build them?

**Build them. Hand-rolled inline SVG, no dependency.** This is not a close call
here, and the reasons are specific to this repo rather than general taste:

1. **The CSP forbids the normal path.** `script-src 'self'` means no CDN. A
   library would have to be vendored into `public/` and committed — a 200 KB
   blob (Chart.js) or 45 KB (uPlot) of code we do not read, in a repo whose
   entire selling point is that it has no dependencies and no build step.
2. **The charts we need are small.** A KPI tile row, ranked horizontal bars
   (top shows by hours, category mix), a coverage/donut, a 90-day air-date
   histogram, and a sparkline or two. That is roughly 150 lines of SVG helper
   code, once.
3. **Themability is the actual requirement.** The dashboard must look right in
   both themes and follow the toggle live. Hand-drawn SVG inherits `--accent`,
   `--ink-dim`, `--outline` and the rest from `styles.css` for free and switches
   instantly with the theme attribute. Every library needs a theme-change hook
   and a palette handed to it in JS, and then still looks like that library.
4. **Data volume is tiny.** 471 episodes, 122 feeds. Nothing here needs canvas,
   virtualisation, zoom or pan.

The escape hatch, stated in advance so nobody re-litigates it: if we ever need
interactive zoom/pan over tens of thousands of points, vendor **uPlot** (45 KB,
zero deps, MIT) and nothing else. Chart.js and D3 are both larger than this
entire front end.

When the charts are actually written, load the `dataviz` skill first, then map
its guidance onto the existing token set rather than importing a second palette.

---

## 5. Storage, and what being a template costs

This repo is a starting point for other Pacifica stations, so the test for every
decision below is not "does it work for WBAI" but **"how many steps does station
number four have to get right?"** Today the honest answer is *more than it
should be*, and analytics makes it worse unless we fix the shape first.

### 5.1 Local is not production, and local never fails

This is the §1/§4 disease in a new location, and it is worth naming before any
storage code is written.

**Every storage test passes locally, by construction.** Run `node server.js` and
`./data` is a real directory on a real disk that nobody is going to delete. It
survives restarts because a restart is just a process starting again in the same
filesystem. There is no image, no container boundary, no mount, no `SIGTERM` on
deploy — none of the machinery that can actually fail exists on your laptop. A
green local check is therefore **not weak evidence that production works; it is
no evidence at all.** That is exactly how the volume bug survived: everything
looked right, because locally everything always does.

So every storage-touching change carries two checks, written down separately,
and the second one is the one that counts:

| | Local (`node server.js`) | Coolify |
| --- | --- | --- |
| Data dir | `./data` in the repo (gitignored) | `/app/data` — a mount, or a lie |
| Survives a restart | Always. Same filesystem. | Only if the volume is real |
| Survives a *deploy* | **No such event exists** | New container, new image; `/app/data` is whatever the mount hands it |
| `SIGTERM` on shutdown | Only when you kill it yourself | **Every single redeploy** |
| Writability | Your user owns the repo | uid `node` inside the container; can fail |
| Disk full / read-only | Effectively never | Possible, and silent |
| TLS | `http://localhost:8080` (a secure context, so `Secure` cookies work) | Real certs via Traefik |
| Proving persistence | **Impossible.** Nothing here can fail. | `curl -s https://<host>/healthz` — §5.4 |

**The rule, stated so it can be checked:** no storage claim is "done" on a local
result. Local proves the *code path* runs — that a file gets written, that the
flush fires, that the JSON parses. Only a redeploy followed by `/healthz` proves
the *storage*. Both belong in every definition of done below, on separate lines,
and the phase is not finished when only the first is ticked.

Two corollaries worth building in rather than remembering:

- **Make the difference visible at runtime.** On boot, log one line naming the
  resolved `DATA_DIR`, whether it is writable, and whether it looks mounted.
  Someone reading Coolify's log stream should be able to see the answer without
  knowing to ask.
- **Make production self-describing.** §5.4's `/healthz` fields exist so that
  the answer is *read* rather than inferred — the same instinct as CLAUDE.md §1's
  version stamp. If you find yourself reasoning about what production probably
  did, stop and curl it.

### 5.2 One data dir, one mount, one env var

Three separate env vars currently name three files —
[`SHOWINFO_PATH`](../server.js#L23), [`PROGRAMS_PATH`](../server.js#L29),
[`FEEDS_PATH`](../server.js#L214) — each defaulting into `./data`. Analytics
would make it four. That is four chances to point a station at the wrong place,
and four things to explain in DEPLOYMENT.md.

**Introduce a single `DATA_DIR` (default `/app/data`) and derive the rest from
it.** Keep the three existing vars working as overrides so nothing breaks, but
document only `DATA_DIR`. A new station then has exactly one storage fact to get
right, and it is the same string as the mount path:

```
DATA_DIR=/app/data           ← env var
/app/data                    ← Coolify Persistent Storage mount
```

Layout under it:

```
/app/data/
  showinfo.json              harvest cache      (rebuildable)
  programs.json              program directory  (rebuildable)
  feeds.json                 feed cache         (rebuildable)
  .instance.json             volume identity    (see 5.3)
  stats/
    2026-07.json             monthly rollups    (NOT rebuildable — the only
    2026-08.json             irreplaceable data this app has ever had)
```

The distinction in that last comment is the whole reason this section exists.
Everything the app has stored until now could be thrown away and re-fetched
within minutes. Analytics cannot. The moment Phase 5 ships, `/app/data` stops
being a cache and becomes data, and it has to be treated accordingly.

### 5.3 The volume has to be configured in Coolify's UI, not inferred

CLAUDE.md §4 records that Coolify was observed ignoring the volume declared in
`docker-compose.yml` (2026-07-26). While auditing for this plan I found a
plausible mechanism, and it is worth writing down because it will bite every
station that copies this template:

[`Dockerfile:22`](../Dockerfile#L22) declares `VOLUME ["/app/data"]`. When a
container starts from an image with a `VOLUME` instruction and *no explicit
mount for that path*, Docker creates an **anonymous** volume — data lands in a
volume with a random name, invisible in any UI, and a redeploy starts a new
container with a **new** anonymous volume. Everything "persists" perfectly right
up until the next deploy, which is exactly the symptom that was observed.

So the deployment instruction for every station is:

1. In the Coolify app → **Storages** → **Add Persistent Storage**, type
   **Volume Mount**, name it `wbai-archive-data`, destination path `/app/data`.
   Set it **in the UI**, on the application resource. Do not rely on the
   `VOLUME` line or on `docker-compose.yml` being honoured.
2. Set `DATA_DIR=/app/data` (or leave it — it is the default).
3. Redeploy, then run the check in §5.4. **Do not skip step 3.** The failure
   mode is silent and only visible one deploy later.

The `VOLUME` line was dropped from the Dockerfile for exactly this reason: it
provides nothing an explicit mount does not, and its only observable behaviour
is the trap above.

### 5.4 Make the volume prove itself

`storage.showinfoOnDisk` on `/healthz` was a good first probe, but it answers
"did a cache survive" — and a cache can be non-empty for reasons unrelated to
the mount. Replace it with something unambiguous.

On first boot, write `$DATA_DIR/.instance.json`:

```json
{ "id": "<random>", "firstBoot": 1785450000000, "station": "wbai" }
```

On every subsequent boot, read it. `/healthz` then reports:

| Field | Meaning |
| --- | --- |
| `storage.persistedSince` | `firstBoot` timestamp — **and its age is the proof.** A value older than the current deploy means the volume genuinely survived a redeploy. |
| `storage.instanceId` | Changed since last deploy ⇒ the volume was replaced. This is the anonymous-volume symptom, named. |
| `storage.writable` | As today. |

One `curl -s https://<host>/healthz` now answers the question for any station,
with no inference and no waiting to see what happens. The Studio's health panel
(Phase 3) renders this as a single pass/fail badge — the thing a station
operator who has never read this document will actually look at.

### 5.5 Two bugs that would eat analytics data — **both fixed in Phase 1b**

They cost nothing at the time because every file under `data/` was rebuildable;
they would have become data loss the day Phase 5 shipped. Kept here because the
reasoning is the reusable part.

**No shutdown flush.** There is no `SIGTERM` or `SIGINT` handler anywhere in
`server.js` (verified by grep). [`writeJsonSoon`](../server.js#L664) debounces
writes by 10 seconds *and calls `t.unref()`* on the timer, so a pending write
does not hold the process open. Coolify redeploys by sending `SIGTERM`.
Therefore **every redeploy currently discards up to 10 seconds of pending cache
writes** — and would discard every counter accumulated since the last flush.
Fix: a shutdown handler that runs the pending writers synchronously and then
exits, plus a matching `beforeExit`.

**Non-atomic writes.** `writeJsonSoon` does a plain `fs.writeFileSync` over the
live file. A crash or an out-of-space condition mid-write leaves a truncated
JSON file, which `readJsonFile` then discards wholesale at next boot — silently,
because it catches and returns the fallback. For a cache that is a re-fetch. For
a month of analytics it is the month. Fix: write to `<file>.tmp`, `fsync`,
`fs.renameSync` into place — rename is atomic on the same filesystem.

### 5.6 Per-station configuration surface

The full "stand up a new station" story is [ROADMAP.md](ROADMAP.md) item 4
(station profiles) and is **out of scope here** — station name, stream URL and
upstream hosts are still spread across `public/` and the `UPSTREAM` object. This
plan only promises not to make that job harder:

- Every studio setting is an env var, never a code edit: `STUDIO_PASSWORD`,
  `STUDIO_SECRET`, `STUDIO_SESSION_HOURS`, `DATA_DIR`.
- Rollup files carry a `station` field, so a volume that is restored, copied or
  attached to the wrong app is caught rather than silently merged.
- No schema, no migrations, no database — a station's entire analytics history
  is a directory of small JSON files that can be copied with `scp`, diffed,
  and read by a human. For a template maintained by volunteers across several
  stations, that is worth more than query performance we will never need.
- Ship a `.env.example` listing every variable with its default. `.env` and
  `.env.*` are already gitignored.

---

## 6. Phases

Each phase ends in something that can be deployed and verified. Nothing later
is a prerequisite for anything earlier.

### Phase 1 — the gate — **BUILT 2026-07-30**

The auth shell, with a deliberately plain page behind it. The dashboard is
Phase 2; what is there now is storage, content counts, harvest health and build
info — enough to prove a session works, and it happens to render the storage
verdict Phase 1b just earned.

**Built**
- ✅ `admin/studio.html` + `admin/login.html`, outside `public/`, read only by an
  authenticated route. `COPY admin ./admin` added to the Dockerfile — without it
  the studio would have 500'd in production while working perfectly locally.
- ✅ `public/studio.css`, `public/studio.js`. The CSS is layout only; every
  colour comes from a `styles.css` token, which is why both themes and the
  toggle work with no extra code.
- ✅ Auth in `server.js`: env vars, `timingSafeEqual` over hashed inputs, HMAC
  session cookie, rate limiter, and the routes in §3.4.
- ✅ Narrow `POST` allowance — the two auth routes only; everything else still
  405s (constraint #1). Studio-safe headers: `private, no-store` + `Vary: Cookie`
  (#6).
- ✅ **`stampAssets()` generalised** to a regex over all local `.css`/`.js`
  references (#4). It was three hardcoded filenames, which worked exactly until
  someone added a fourth — and the fourth would have been the newest code in the
  repo, silently exempt from the guarantee that exists because staleness cost
  this project the most time of any bug class.
- ✅ `studioVersion` on `/healthz`, separate from `version`. Folding it in would
  have made DEPLOYMENT.md's "the version must change or the old image is still
  serving" rule fire falsely on every studio-only deploy.
- ✅ `/healthz` deliberately does **not** report whether the studio is enabled —
  it is a public endpoint and there is no reason to hand a scanner the path.
- ✅ Theme toggle reusing `window.WBAITheme`, same markup as the listener app —
  **on both pages**, including the login screen. The brief asked for the app's
  own light/dark control; a door that can't be switched is not that.
- ✅ Polling stops while the tab is hidden and refreshes on return. A studio left
  open overnight would otherwise make ~2,900 requests nobody reads.
- ✅ `:focus-visible` on the studio buttons — the accessibility bar the rest of
  the app is held to.
- ✅ `.env.example`, DEPLOYMENT.md, DEVELOPMENT.md, README.md and CLAUDE.md §5
  updated. DEVELOPMENT.md matters specifically: the repo's rule is that it
  documents only what is built and working, and as of today that includes
  durable storage and the studio.

**Verified** — `test/studio/studio-tests.js`, 35 assertions against a real server
process, all passing:
- Disabled: `/studio` serves the listener app, `/api/studio/*` is not a studio
  response, `POST /api/studio/login` is a plain 405, `/healthz` says nothing.
- Enabled: login page served, assets stamped, `no-store` + `Vary: Cookie`.
- Refused: no cookie, wrong password, empty body, tampered signature, expired
  session, session signed with the wrong secret, unsigned session.
- `admin/*.html` unreachable via five path shapes including `..` traversal.
- Rate limiting asserted by effect (a `Retry-After` appears, and the *correct*
  password is refused while locked) rather than by reading a counter.
- `PUT` to the login route and `POST` to `/api/archive` are both still 405.
- Rendered in headless Chrome, both themes and at 390px: no CSP violations, no
  console errors, no horizontal scroll, login → dashboard through the real form.

**Two things the tests did not catch, and what fixed them**

1. The studio sent `storageDiag` wholesale and rendered **"undefined feeds"** to
   the operator: `feedsOnDisk` lives on `feedsDiag`, and only `/healthz` knew to
   fetch it. Every test passed — JSON omits an undefined key, so absence looks
   like nothing at all. A screenshot found it in one second. Fixed at the class
   level with a single `storageReport()` used by both endpoints, plus a test
   that names each expected key and one that asserts the two endpoints report
   *identical* key sets.
2. Nothing here is provable by asserting structure. That is what §3a is about,
   and it is why the suite pairs every refusal with the same request succeeding
   under a valid session.

**One accepted limitation, pinned by a test rather than left to be discovered:**
sessions are stateless, so signing out clears the browser's cookie but cannot
invalidate a value already copied off a device — it stays valid until it
expires. That is the price of having no session store, which is deliberate
(§3.2: this app's storage was unreliable for months). Rotating
`STUDIO_PASSWORD` revokes everything at once and is the documented path.

### Phase 1b — durable storage — **DONE, both halves, 2026-07-30**

Built first, ahead of the gate, because it makes the template deployable and
Phase 5 is unsafe without it. Local *and* production verified — and per §5.1 it
is the production half that made it finished. **The volume at
`wbai.supersoul.top` now demonstrably persists across deploys**, for the first
time since the problem was recorded on 2026-07-26. Evidence in the Coolify
checklist below.

- ✅ `DATA_DIR` env var; `SHOWINFO_PATH` / `PROGRAMS_PATH` / `FEEDS_PATH` derived
  from it and kept as overrides (§5.2). Plus `STATION_ID`, stamped into
  `.instance.json`.
- ✅ Atomic writes — tmp + `fsync` + `rename` — via `writeJsonAtomic` (§5.5).
- ✅ `SIGTERM` / `SIGINT` / `beforeExit` handler that flushes pending writers
  synchronously, then re-raises the signal so the exit status stays 143 (§5.5).
- ✅ `.instance.json` volume identity; `/healthz` reports `instanceId`,
  `persistedSince`, `bootedAt`, `freshVolume`, `dataDir` (§5.4). A data dir that
  predates the marker is dated from the oldest cache file rather than reported
  as fresh — otherwise the very deploy that adds this would cry wolf.
- ✅ Boot log line naming the resolved dir, its writability, what is mounted
  there and whether it has persisted.
- ✅ **Mount probe** (`/proc/self/mountinfo`), added after the two-deploy
  verification was — fairly — challenged as unnecessary friction. The marker is
  retrospective by nature, so it cannot speak on the deploy that creates the
  volume. Asking the kernel what is attached needs no history: `mounted:false`
  means the data dir is the container's own layer, and a 64-hex volume name
  means Docker invented it (an anonymous volume — the original bug). **Deploy
  one can now disprove persistence outright; only confirming it still needs a
  second.** Advisory, not authoritative: the source path is not guaranteed to
  carry the volume name on every storage driver, so `instanceId` stays the
  proof. Linux-only, and reports `null` rather than `false` where there is no
  `/proc` — unknown must not read as broken.
- ✅ `test/storage/mount-tests.js` — the parser cannot run on macOS, and its
  first execution ever should not be the production deploy someone is depending
  on it to diagnose. Fixtures cover named, anonymous, bind, absent, parent-dir
  and space-escaped mounts, plus the unknown-vs-absent distinction. Requiring
  `server.js` no longer starts a listener (`require.main === module`).
- ✅ `VOLUME` dropped from the Dockerfile (§5.3), with the reason recorded there.
- ✅ DEPLOYMENT.md rewritten around the new diagnostic; CLAUDE.md §4 updated —
  it still named `showinfoOnDisk` as the only proof, which is no longer true.
- ✅ `.env.example` (and a `!.env.example` negation in `.gitignore`).

**Definition of done** — two lists, per §5.1. Ticking only the first is the
failure mode this whole section exists to prevent.

*Local — proves the code path runs. All ✅ on 2026-07-30:*
- `node --check server.js`; server restarted and re-verified per CLAUDE.md §2;
  `/healthz`, `/api/nowplaying`, `/api/archive`, `/api/programs` all unchanged.
- A fresh `DATA_DIR` makes `seedShowInfo()` queue a debounced write at boot,
  which is the redeploy case exactly. `SIGTERM` 2s in → `showinfo.json` written
  (28 KB). Same under `SIGINT`. **Under `SIGKILL` → nothing written** — that
  control is the point (§3a): it proves the file appears *because of the
  handler*, not because the test is measuring something else. Exit status 143.
- Booted three times against one dir: `instanceId` identical each time,
  `freshVolume` true on boot 1 and false after.
- Half a JSON object in `showinfo.json` → logged by name and byte offset,
  recovered from the seed, file rewritten valid. No stray `.tmp` left anywhere.
- `DATA_DIR=<tmp>` put everything there and nothing in `./data`.

*Coolify — proves the storage, and nothing above substitutes for it. All ✅ on
`wbai.supersoul.top`, 2026-07-30:*
- ✅ Persistent Storage added in the **Storages** UI: Volume Mount, path
  `/app/data` (§5.3). Coolify prefixes the name with the resource id, so it
  appears as `ug084sokwwsw08gowoo08ogs-wbai-archive-data` — still a *named*
  volume, which is the only thing that matters.
- ✅ Deploy 1: `mounted:true`, `anonymousVolume:false`. The first-deploy check
  earned its keep — this is the reading that would have failed instantly, and
  visibly, under the old anonymous-volume bug.
- ✅ Deploy 2: `instanceId` **identical** (`0f623981-b387-4b60-a048-db9efdbcf1a1`
  both times), `freshVolume:false`, `persistedSince` predating boot 2 by 231s.
- ✅ Corroborating, and not something a marker could fake: `showinfoOnDisk`
  0 → 49 and `feedsOnDisk` 0 → 122 across the two boots. Real cached data came
  back.

**An unplanned dividend.** Deploy 2 reported `notModified: 122` — every one of
the 122 feeds answered `304 Not Modified`, because the `lastModified` values
cached on the volume survived the deploy. Before this, each deploy re-downloaded
all 122 feeds in full. WBAI runs a small Apache, which `FEED_CONCURRENCY`'s
comment in `server.js` is already careful about; persistence turns every future
deploy from 122 downloads into 122 conditional requests. The volume was framed
as protecting *our* data. It also stops us hammering theirs.

### Phase 2 — the content dashboard — **BUILT 2026-07-30**

`GET /api/studio/stats`, computed from the feed cache the listener app already
holds, so the dashboard and the site can never disagree. ~600 items; no cache of
its own.

**Panels** — KPI row (shows, episodes, hours, GB, categories, window), thinnest
coverage, episodes held per show, episodes by category, episodes by air date,
episode length, coverage meters, and a sortable/filterable table of all 122
feeds.

**Three things the data forced, each a correction to this plan**

1. **"Top shows by hours" was built and thrown away.** Upstream caps every feed
   at five episodes and 83 of 122 shows sit at the cap, so the top twelve are a
   twelve-way tie at 10.01h — twelve identical bars. The chart is now
   **Thinnest coverage**, the ascending end, where a show with one episode has
   either just launched, airs rarely, or has a feed that stopped publishing. A
   test asserts the sort direction so nobody "fixes" it back.
2. **The 149 → 122 → 115 funnel in §2.2 does not exist.** `programs` is keyed by
   normalised title, `feeds` and `showinfo` by archive slug; intersecting them
   directly yields 3, by coincidence. Those three numbers count three different
   things, and drawing them as a funnel would assert a containment that is not
   there. Coverage is three separate meters, each against its own denominator,
   with the title-join's imprecision stated on the page.
3. **Empty days are emitted, not skipped.** `perDay` covers every day in the
   window including the 28 with nothing, because the gaps are the finding. A
   sparse series would have silently closed them up.

**Colour** — one hue for every bar. Shows, categories and length buckets are
nominal, so shading by value would encode the bar's own length twice and spend
the only free channel on nothing. The single place a ramp is legitimate is the
coverage meters, where the steps are ordered — and those opacities were run
through the palette validator per theme. The dark set failed first (fading
toward a dark surface *loses* contrast, so the light end sat below the 2:1
floor) and was re-stepped until it passed. The two sets are deliberately not
mirrors of each other.

**One bug worth recording, because nothing caught it.** Every panel was clipped
on the right at phone widths. HTTP tests green, no console errors, no CSP
violations, and `scrollWidth === clientWidth` — the page did not scroll
sideways, because the overflow was hidden rather than scrolled. Only a
screenshot showed it. Cause: grid items default to `min-width: auto`, so the
section holding the 122-row table refused to shrink below the table's
min-content width and sized the whole column to 619px inside a 390px viewport.
Fixed with `min-width: 0`; `test/studio/run.sh` now measures six widths for
anything painted outside the viewport that is not inside a scroll container,
and **section 3 of it restores the bug and requires the probe to report it** —
an overflow test that has never seen overflow is indistinguishable from a blind
one (CLAUDE.md §3a).

### Phase 2.5 — full width (2026-07-31)

The dashboard was capped at 60rem, which put two narrow columns on a wide
monitor and made comparing any two panels a long scroll. Now `100rem` with
`repeat(auto-fit, minmax(min(21rem, 100%), 1fr))` — four columns at 1440px,
three at 1180 — plus `grid-auto-flow: dense` so a short panel backfills a hole
instead of leaving dead space. The two smallest charts were merged into one
"Shape of the archive" panel so the row's heights are comparable rather than
ragged. **Page height went from ~6,650px to ~2,480px at 1440px.**

That change also removed the original overflow bug's root cause a second time,
by accident worth keeping: a bare `1fr` track has an *automatic* minimum of
`auto`, which is what let the column grow to its content; `minmax()` gives it a
real floor. `test/studio/run.sh` section 3 now removes each defence in turn and
asserts that either one alone holds the layout.

### Phase 3 — operational health — **BUILT 2026-07-31**

Added to `/api/studio/health`, and rendered as three panels (Feed harvest,
Upstream, Process).

- ✅ **Named feed failures**, not just a count — a ring buffer of the last 20
  `{slug, at, error}`. Shown expanded, because an actual failure should not need
  a click to be noticed.
- ✅ **Per-feed staleness** — feeds not *confirmed* within a whole TTL, listed
  oldest first. Meaningful only because `fetchedAt` now moves on a 304, so this
  reads "not checked" rather than "not changed".
- ✅ **Upstream latency and status per host**, recorded from the traffic the app
  already makes. Deliberately no synthetic probes: WBAI runs a small Apache and
  monitoring it by adding requests to it would be self-defeating.
- ✅ **Process** — uptime, RSS, heap, and cache hit/miss on the archive and
  now-playing caches, which is what makes "is the TTL doing anything" answerable.
- ✅ Storage verdict: already shipped in Phase 1.

**A 404 is not a failure.** The first version counted it as one, and
`archive2.wbai.org` immediately showed a permanent fault: 33 of the slugs the
listing advertises have no feed behind them, so `catchUpFeeds` probing them 404s
*by design*. Those are counted as `missing` and reported separately. A panel that
is always red teaches everyone to stop reading it.

### Phase 4 — actions — **BUILT 2026-07-31**

The studio's first and only *write* operations: re-check every feed, refresh the
program directory, re-probe the live stream, drop the archive cache. All four
operate on **our** caches; nothing writes to WBAI.

- **Idempotent by construction** — each is "go and refresh X", so a double-click
  or a retry cannot compound.
- **Cooled down and coalesced.** "Re-check every feed" is 122 requests to a
  small station's Apache; a button that does that on every press is a loaded gun
  pointed at WBAI. It is rate-limited per action *and* joins the in-flight sweep
  rather than starting a rival one. Asserted by effect in the tests, not by
  reading a timer.
- **Logged**, because there is no undo and a line in the log is the only record.
- **CSRF token derived from the session**, not stored: an HMAC of the cookie
  under the same key that signs it. No token table, nothing to expire
  separately, and rotating `STUDIO_PASSWORD` invalidates tokens exactly as it
  invalidates sessions. A test mints a token with the wrong key and requires a
  403, so "the token is a constant the server would take from anyone" cannot
  creep in.

**A bug the button found in code five days older than it.** "Refresh the program
directory" returned *"0 programs" in 1ms* — `refreshPrograms()` guarded itself
with a boolean and returned immediately when a refresh was already running,
which on a cold boot it always was. The action then reported a count from before
any work happened. Fixed by making it hold its in-flight **promise** instead of a
flag, so a second caller awaits the running refresh rather than being told
nothing and guessing — the pattern `feedsInFlight` already used. It now reports
149 programs in ~3.5s. Nothing before Phase 4 ever awaited that function, which
is why the flag had gone unnoticed.

### Phase 5 — listener analytics — **BUILT 2026-07-31**

Shipped only after the prerequisite was met for real: production reported the
same `instanceId` across every deploy for a day, with `showinfoOnDisk` climbing
49 → 50 → 51 across restarts. This is the first data the app has held that no
upstream can hand back.

**What it counts** — `pageview`, `play` (by show), `listen` (**seconds, by
show**), `live`, `search`, `share`.

**Time listened is the headline, added 2026-07-31**, because a play is a click
and a click is not value. The dashboard ranks shows by seconds, not plays, and
the two orders really do differ: in testing a show with 9 plays sat below one
with 3. Measured as media consumed by sampling the player position, so pauses,
stalls and scrubs are excluded; it under-reports slightly and can never
over-report. Two bugs found by measuring rather than reasoning: the baseline was
being set on the first sample tick rather than at `play` (a 50s listen recorded
29s), and the final partial interval was dropped at `pause`.

**Adding a counter turned out to be a migration, and that shipped broken.** Time
listened read zero in production while plays worked perfectly. The cause was not
in the client at all: `statsDay()` initialised the new fields only when it
*created* a day, so the day record already written by the previous build had
`plays` but no `listenSeconds`, and `+= 30` on it produced NaN → `null` on disk
→ a confident zero in the report. No error, no warning, and one metric working
beside the broken one — which reads as "the feature doesn't work" and sends you
looking in the wrong file. The shape is now asserted on every access, and a test
boots a server against a legacy stats file and fails if that regresses. It was
verified by reverting the fix and watching the test go red.

**The write debounce was eating plays, and it disguised itself as an
attribution bug.** On 2026-07-31 the table showed "On The Ground" with *4
minutes listened and 0 plays* — one show, one listen, two counters that appeared
to disagree about it. Everything upstream was correct: the beacon was sent, the
mp3 resolved to the slug, `plays` was incremented. It was then held in memory by
a 60-second flush debounce, and the container was replaced inside that window.

The asymmetry is structural and worth internalising, because any counter added
later inherits it. **A play is one beacon that has to survive the window;
listening time is a stream that keeps re-sending itself.** A restart costs the
stream a single flush and every later beacon lands in the new process, so the
minutes heal and the play is simply gone. The same outage therefore always
presents as "listened, never played" — never the reverse — which points at
attribution instead of at persistence.

**Every per-show number vanished at midnight UTC on the 1st.** On 2026-08-01
"Most listened shows" went to its empty state and the table's *Plays* and
*Listened* columns all read zero, while the day chart, the totals and everything
else on the page stayed correct. The counters were fine and nothing was lost:
the three aggregates iterated `statsStore.days`, which holds **one calendar
month** and is swapped for an empty object at the rollover. The day series
already fell back to the previous month's file; the show aggregates never did,
so they collapsed the moment the month changed.

All of them now go through `recentDays(30)`, which returns the day records for a
**rolling** 30-day window — memory for the current month, the month file for
anything earlier, cached per call so a 30-day window costs at most two reads.
The 1st now looks like the 2nd. `test/studio/` seeds a day in the previous month
plus one in the current month and requires the totals to include both, so
neither half can go missing unnoticed; on the 30th and 31st the window genuinely
fits inside one month, and the test says so rather than passing vacuously.
Verified by reverting the aggregation and watching it go red.

The general lesson is the one in CLAUDE.md §3a: *the reporting window and the
storage layout are different things, and code that conflates them works fine
until the calendar disagrees.* Anything summing usage must go through
`recentDays`, never `statsStore.days` directly.

`flushOnExit` covers the graceful stop and did its job; a SIGKILL, an OOM or a
host reboot has no signal to catch. The debounce is now **5 seconds** — still
tens of beacons per write on a busy minute, with 12× less to lose — and
`test/usage/durability-tests.js` kills a server with SIGKILL after the window
and fails unless the play is on disk, with the killed-immediately case as its
self-test so it cannot pass blind (CLAUDE.md §3a). Verified by restoring the
60-second value and watching it go red.

**The abuse ceiling was raised from 120 to 600 beacons per address per minute**
on the same evidence. A listener sends ~2 a minute, so 120 tolerated only ~60
concurrent listeners *per address* — and carrier-grade NAT puts thousands of
mobile users behind one. That would have undercounted a popular show silently,
which is the worst failure this counter has: it reads as a quiet day. The
ceiling still exists — keyed by an HMAC of the address salted with a value
generated at boot and never written, so it cannot be reversed or correlated
across restarts — and `droppedBeacons` now reports when it bites, so the
dashboard says the figures are low rather than leaving it to be guessed.

**What it cannot do, structurally.** No event log, no cookie, no session, no
stored or hashed IP. A request increments a counter in memory
and is dropped. Nothing links two events to the same person, so **"unique
listeners" is not a number this app can produce** — a deliberate trade, not an
oversight. A station that asks its audience for money should be able to say what
it collects in three sentences and have them be true. (One coarse attribute was
added in 5.1 below; the linkage claim is unchanged, because there is still
nothing to link it *to*.)

**Search terms: collected on 2026-07-31, removed the same day.** Worth recording
because the reason was not the one you would expect.

The station said yes, and it shipped behind a storage threshold — a term was
never written to disk until several different searches had used the same words,
aggregated per month so it could not be tied to a time of day. The privacy
engineering worked exactly as designed.

It was removed on **product** grounds. The search box filters as you type, so
there is no Enter key and no moment that means "this is my query": people find
what they want after two or three characters and stop. What came back was mostly
stems, capturing the settled phrase meant guessing around pauses in typing (a
first attempt recorded `"democ"` and dropped `"democracy now"`), and the whole
mechanism cost two timers and a threshold to produce data nobody could act on.
The count of searches is genuinely useful. The words were not worth having.

### Phase 5.1 — reach, without geolocation — **BUILT 2026-08-01**

The ask was "add location to the admin view". §10.4 had parked geography from IP
on the grounds that it would make the README's privacy paragraph longer and more
conditional — so the first move was to ask what the location was *for*, and the
answer was the one question a community station actually has: **does this
station reach past its own signal.**

That question does not need an address. The browser will volunteer its own IANA
timezone, so a page view now carries `z`, the server files it under one of four
buckets, and the string is discarded in the same expression that classifies it.
What reaches the disk is `{"local":41,"national":9,"intl":3,"unknown":0}`.

**Why not IP.** There is no Cloudflare in front of this — Coolify's Traefik
only — so there is no `CF-IPCountry` header to read for free. Resolving it
ourselves meant either shipping a multi-MB IP→country table that every forking
station then has to keep current, or calling a third-party lookup, which would
send listener addresses to someone else and is *worse* than storing them. A
timezone costs one counter and a static `Set`.

**What it is honestly worth, and the label that says so.** A timezone is not a
location. Nearly every browser east of Ohio reports `America/New_York` whether
it sits in Brooklyn or Miami, so the local bucket is **a clock, not a city** —
and the temptation to label that row "New York area" is exactly the failure this
design is trying to avoid, a number that reads as more than it is. So the
*server* ships the labels with the data (`reach.buckets[].label`), the local row
is titled with the raw zone name, and the studio note says outright that
travellers and VPNs count wherever their clock is set. `unknown` is shown while
non-zero and hidden once it empties: right after a deploy it is simply everyone
still on a cached page, and folding those into `local` would have manufactured a
surge of local listeners on the day the feature shipped.

**The migration hazard from Phase 5 was already handled and this proves it.**
`byZone` was added to the `MAPS` list in `statsDay()`, which asserts the shape on
every access rather than at creation — so day records written by the previous
build picked up the new map without the `undefined + 1 → NaN → null` failure that
broke listening time. The existing legacy-stats-file test covers it and stayed
green with no change.

**Two things that could have gone wrong quietly, and the tests that watch them:**

- **`America/` is not "the United States".** `America/Sao_Paulo`,
  `America/Bogota` and `America/Toronto` all share the prefix. A prefix check
  would have counted South America as domestic and nobody would have noticed,
  because the number would still look plausible. `US_ZONES` is an explicit set
  including the territories and the legacy `US/*` aliases, and a test asserts
  Sao Paulo lands in `intl`.
- **An absence assertion that goes blind.** "The raw timezone is not on disk"
  passes perfectly if the beacons stopped arriving, which is CLAUDE.md §3a
  exactly. Every absence check here is paired with a count that had to move, and
  the disk check *polls for `byZone` to appear* before asserting the string is
  not beside it. Verified by mutation, not by assumption: bucketing everything
  as `local` reddens three tests, and writing the raw zone as the key reddens the
  disk check and its self-test together.

**Per-station.** `STATION_TZ` (default `America/New_York`) is the only new
setting — one env var, per the template rule. Verified by booting a second
server as a west-coast station: `America/Los_Angeles` became `local` and
`America/New_York` moved to `Elsewhere in the US`. A station outside the US
never matches `US_ZONES`, so `national` stays empty and everything non-local
reads as `intl` — mislabelled rather than miscounted, and ROADMAP item 4
(per-station profiles) is where the wording would be fixed.

**The README changed in the same commit**, per CLAUDE.md §5: the word
"fingerprint" came out of the promise list, because a timezone *is* a classic
fingerprinting signal even though it is not being used as one here (there is
nothing to join it to). Naming it plainly is the point — this is the first
visitor attribute the app has ever collected, which is a change of kind, not of
degree, and it should be read that way rather than discovered.

So the promise is back to its strongest form — the words never leave the
browser — and the test asserts it that way: send a term the way a stale cached
client would, and require it to reach neither the report nor the disk. Terms
written by the brief build are **stripped when a month file is loaded**, so the
removal is retroactive rather than merely forward-looking.

The lesson is the one worth keeping: a threshold, a purge and two timers are all
cheaper than asking whether the data is worth collecting at all.

**The tracker touches `app.js` not at all.** `public/track.js` is loaded
separately and listens from outside:

- Media events do not bubble, but they *do* propagate through the capture phase,
  so one capturing listener on `document` catches `play` from both the static
  archive element and the live element `app.js` builds and discards per
  connection. Verified with a real `play()` in headless Chrome, because that
  assumption was the whole design risk.
- **The show is resolved server-side** from the media URL against the feed index
  already in memory. The tracker never has to know how `app.js` represents the
  current episode, so it cannot break when that changes — and a URL that does
  not resolve is an unattributed play rather than a guess.

**Per-show plays live in the table, not only the chart.** "Most played" is a top
twelve, which cannot answer "how did *this* show do". Every row of the feed
table carries its own play count, sortable, next to a filter box — so a single
show is one search away. Shows with none report `0` rather than a blank.

**Storage** — `$DATA_DIR/stats/YYYY-MM.json`, aggregates only, flushed on a 60s
debounce and on `SIGTERM`. Verified: nothing on disk during the debounce,
everything written on shutdown. Without Phase 1b's flush handler every redeploy
would have silently dropped up to a minute of counters.

**A bug caught by looking.** The peak label on the day chart rendered "peak 4"
for a value of 41 — centred text runs past the SVG edge when the peak is the
last column. That is a wrong number on screen wearing the same confidence as a
right one. Fixed by anchoring to the edge instead of centring, and
`test/studio/run.sh` §2b now measures every chart label's box against its SVG's
box at three widths.

### Phase 5.2 — windows, history, comparison, export — **BUILT 2026-08-03**

The listening figures were displayed over a hard-coded 30-day window while the
month files under `$DATA_DIR/stats/` are kept forever — so all the data existed
and only the last month of it was reachable. This phase is presentation only:
**nothing new is collected**, so the README's privacy paragraph is untouched.

- **One window for the whole listening report.** `?days=7|30|90|365|all` on
  both `/api/studio/usage` and `/api/studio/stats`, driven by a single picker
  in the studio — the KPIs, the day chart, reach, top shows and the Every Feed
  plays/listened columns all move together, so two panels can never silently
  describe different periods. The menu is a fixed `Set`, not a free integer:
  an off-menu value falls back to 30 rather than walking arbitrary dates, and
  `all` is resolved against the month files actually on disk. Both payloads
  echo the window back (`windowDays` / `usageWindowDays`) so the page labels
  what it *got*, not what it asked for.
- **Per-show history.** `/api/studio/showhistory?slug=` sums one slug across
  every month file, zeros included — a month a show recorded nothing is a
  measured zero, not a gap. In the studio, every row of the Every Feed table
  opens it (keyboard-operable — a click-only `<tr>` is invisible to a
  keyboard). The slug is shape-checked before it touches a file path.
- **CSV export.** Client-side, from the same `visibleRows()` the table
  renders, so the download is exactly the table as filtered and sorted — not a
  second report that can disagree with the first. Raw seconds, not the "4m"
  display buckets (a spreadsheet can format but cannot un-round), and cells
  starting with `= + - @` are prefixed to keep upstream show titles from
  executing as spreadsheet formulas.

Tested in `test/studio/studio-tests.js` on the existing rollover fixture (a
seeded previous-month file plus a live current-month beacon): `all` must see
both months, `7` must see what the calendar says it should, an off-menu window
must fall back, and the history endpoint must return the seeded numbers and
401 without a cookie.

---

## 7. Non-goals

- **Multiple users, roles, or a user table.** One password is the brief. If
  per-person access is ever needed, that is a different design and should not be
  bolted onto this cookie.
- **A database.** No sqlite, no Postgres, no ORM. The data is counters; JSON
  files on a mounted volume are the whole requirement, and for a template that
  volunteers at several stations have to operate, "you can read the file" beats
  every feature a database would add. Revisit only if a station outgrows it,
  which the arithmetic in §5.2 says will not happen.
- **Editing content from the studio.** The archive is upstream's; this app is a
  reader. Phase 4's actions operate on *our caches*, never on WBAI's data.
- **A second front-end framework.** Vanilla JS, same as everything else here.
- **Merging the studio into the listener app's bundle.** See §1.
- **Cross-station reporting.** Each station is its own deploy with its own
  volume and its own studio. A combined Pacifica-wide view is a different
  product; the `station` field in §5.6 is the only concession to it, and it
  exists to prevent mistakes, not to enable aggregation.

---

## 8. Open questions and risks

Resolved ones are kept with their answers, because "we already looked at this"
is worth more than a shorter list.

1. ~~**The volume is not yet proven.**~~ **Resolved 2026-07-30.** Persistent
   Storage configured in Coolify's Storages UI; `instanceId` held across every
   deploy since, with cached data returning (`showinfoOnDisk` 0 → 49 → 51).
2. ~~**`Secure` cookies and local dev.**~~ **Resolved.** `http://localhost:8080`
   is a secure context, so the cookie is accepted; the flag also keys off
   `X-Forwarded-Proto` in production.
3. **Password distribution.** Still open, and still the weakest link — an env
   var in Coolify is fine, the password reaching someone's phone over SMS is
   not. Worth a line of guidance in DEPLOYMENT.md.
4. ~~**Should the studio be linked from the app?**~~ **Answered: no link.** The
   URL is told to the people who need it. Nothing has made that annoying yet.
5. **Retention framing.** Still open, and now the most interesting one: with a
   five-item cap, "474 episodes" is a snapshot, not a total. Trends over time
   need a *third* kind of data — periodic snapshots of our own inventory. See
   §10.2.
6. **Who holds the password for stations we don't run?** Still open. Nothing in
   this design lets us into another station's studio, which is correct, but it
   means supporting them is talking someone through a `curl`. Worth deciding
   before there are four of these.
7. **Sessions cannot be revoked individually.** Accepted, pinned by a test, and
   documented: rotating `STUDIO_PASSWORD` invalidates everything at once. It
   only becomes wrong if the station ever wants per-person access, which is §7.

---

## 9. Working on this

- **Reread CLAUDE.md §1 and §2.** The studio has client assets *and* server
  routes, so the stale-asset guardrail and the restart-and-verify rule are live
  on almost every commit here.
- **Adding a counter is a migration.** `statsDay()` backfills every field on
  every access; add new ones to its `NUMBERS`/`MAPS` lists and nothing else.
  Initialising them only at creation is what made listening time read zero in
  production while plays worked (§6, Phase 5).
- **Changing what is collected changes a public promise.** The README and the
  page both tell listeners what is and is not recorded. Change them in the same
  commit, and check the test that enforces it.
- **Look at the page, not just the tests.** Three real bugs this project shipped
  — `undefined feeds`, every panel clipped at phone widths, and `peak 4` for a
  value of 41 — were invisible to green suites and obvious in a screenshot.

---

## 10. Brainstorm — where this could go next

**Nothing here is committed.** It is a menu with prices attached, so a decision
can be made on value rather than on which idea was mentioned most recently.
Anything adopted moves up into §6 with a build record.

### 10.1 What this design makes impossible — read before proposing

The no-identity choice is load-bearing, and several obvious-sounding features
are *arithmetically* out of reach because of it. Better to know now than to
discover it three days in:

| Asked for | Why it cannot be built here |
|---|---|
| **Unique listeners / reach** | Requires linking two events to one person. There is no cookie, no session, no fingerprint and no stored IP. Not hard — impossible by construction. |
| **Returning vs new listeners** | Same reason. There is nothing to compare against. |
| **Session length, "average listen per person"** | We know total seconds and total plays. Their ratio is *seconds per play*, which is a genuinely useful number (§10.2) — but it is not per person and must never be labelled as such. |
| **A search → play funnel** | Needs the two events tied to one visitor. |
| **Where a listener went next** | Same. |
| **Per-listener geography** | Needs the IP kept long enough to resolve. Country-level counting is *arguably* possible without retention (§10.3), but it is a genuine policy decision, not a technical one. |

If a station genuinely needs reach numbers, the honest answer is that this is
the wrong instrument and a real analytics product is the right one — with the
privacy cost stated plainly rather than discovered later.

### 10.2 Stats worth building

Ordered by value ÷ effort. The first three need **no new collection at all** —
the data is already on disk.

**A. Completion rate — "did anyone finish it?"** ★ best value here
Every feed item carries `durationSec`, and we already record seconds listened
per show. `secondsListened ÷ (plays × durationSec)` is a completion ratio, and
it answers the question a programmer actually has: *people open this show and
leave, but they sit through that one.* It separates a popular title from a good
one. **Effort: small — arithmetic over data already held.** Caveat to design
around: a show with 2 plays and 1 long listen will read >100%; cap the display
and require a minimum play count before ranking on it.

**B. Seconds per play, per show.** Falls straight out of the same two numbers
and is less prone to the caveat above. A blunt but honest "how long do people
stay" figure. **Effort: trivial.**

**C. Shows nobody played.** The inverse of "most listened", and the more
actionable list: a show with a healthy feed and zero plays all month is either
mis-titled, badly placed, or invisible in the UI. **Effort: trivial** — every
row already carries its play count; this is a filter and a heading.

**D. Time-of-day and day-of-week.** When is anyone actually listening? A 7×24
heatmap is the natural form and the archive is *on demand*, so this is not the
broadcast schedule — it is when people choose to catch up, which is a different
and more interesting fact. **Effort: medium.** Needs an hour bucket added to the
day record (`byHour: {0..23}`), which is 24 more integers per day — trivial
storage. Adding it is a migration; see §9.

**E. Month-over-month.** — **Tried in Phase 5.2, removed.** The rollups are
already per month, so "this month vs last" was a second file read and a delta,
no new storage. Built as a table wedged into the Listening section; pulled
back out because it didn't scroll well and read as a second, competing table
right next to Every Feed. If revisited, it needs its own section (or to fold
into the per-show history drill-down) rather than sitting inline above it.

**F. Inventory snapshots — the missing third data type (§8.5).** Everything in
Phase 2 is a *snapshot* of a rotating five-item window; nothing records what the
archive looked like last week. A nightly line in `stats/inventory.json` —
episodes, hours, feeds held, shows at the cap — would make "are we growing or
shrinking" answerable, which today it simply is not. **Effort: small, and it
gets more valuable every day it runs**, which is an argument for starting it
before it is wanted.

**G. Per-episode, not just per-show.** We resolve the mp3 URL to a feed item
already, so counting by episode is nearly free — except that episodes rotate out
every few days and the key set grows without bound. Needs a pruning rule (drop
episodes absent from the feed for N days) before it is safe. **Effort: medium,
mostly the pruning.**

**H. Sparklines in the feed table.** A 30-day per-show trace beside each row.
The chart primitives exist; this is layout. **Effort: small. Value: moderate** —
pretty, and occasionally reveals a show falling off a cliff.

**I. CSV / JSON export.** — **BUILT, Phase 5.2** (CSV, from the Every Feed
table as filtered and sorted). Board reports are written in spreadsheets. One
button that hands over what is already on screen.

### 10.3 Admin features beyond stats

**J. Alerting.** The dashboard answers "is anything wrong" only if someone
opens it. A webhook POST on: feed harvest failures above a threshold, the live
stream unreachable, the volume reporting `freshVolume` on a redeploy (data
loss!), or the archive listing going empty. A webhook needs no SMTP, no
dependency, no credentials beyond a URL in an env var. **Effort: small.
Value: high** — the volume bug ran for weeks precisely because nothing shouted.

**K. A public status page.** A subset of `/healthz` rendered for humans at
`/status`, no auth: is the stream up, is the archive fresh. Useful to listeners
during an outage and cheap to build from existing data. **Decide first** whether
the station wants to publish its own uptime.

**L. An incident log.** Record every transition of the live-stream probe and
each harvest failure with a timestamp, so "was it down last Tuesday?" has an
answer. A few hundred bytes a day in the same rollup directory. **Effort: small.**

**M. Content QA panel.** Shows with no artwork, no description, a title that
does not match the programme directory, or a feed that has not published in 30
days. The data is all held; this is a query and a list. **Effort: small.
Value: high for the people who maintain the station's own metadata** — it turns
the coverage meters from a number into a to-do list.

**N. "What changed" digest.** New shows appearing, shows that stopped
publishing, titles that changed upstream. Requires comparing harvests, so it
pairs naturally with F. **Effort: medium.**

**O. Per-station branding for the studio.** Currently the header reads
`STATION_ID`. If ROADMAP item 4 lands, the studio should take the same profile.
**Effort: trivial once item 4 exists; do not build it before.**

### 10.4 Deliberately parked

- **Any form of per-person measurement** — §10.1. Not a maybe.
- **Geography from IP.** Still parked, and now for a second reason: the question
  it was wanted for — *does this station reach past its own signal* — got a
  cheaper answer that never reads an address at all. See Phase 5.1 (reach by
  timezone). If someone asks again for IP geography, the thing to establish
  first is what the extra resolution is *for*, because city-level counts cost a
  multi-MB table every forking station must keep current, plus the longer and
  more conditional privacy paragraph this bullet was always about.
- **A database.** §7 still holds. If a station outgrows JSON files, that is a
  happy problem and a different design.
- **Multiple studio users with roles.** §7. Revisit only if a station asks, and
  then as a new design rather than a widening of the cookie.
- **Anything that writes to WBAI.** §7. The actions in Phase 4 touch our caches
  only, and that boundary is worth keeping bright.
