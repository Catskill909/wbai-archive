# The Studio — a private view for the people who run this thing

**Status: Phases 1b and 1 are built and verified (2026-07-30). Phases 2–5 are
still proposals.** Per [ROADMAP.md](ROADMAP.md)'s rule this file describes
intent, so treat everything below Phase 1 as a plan rather than a description —
each phase says which it is.

Five decisions are already made and everything below assumes them:

- **The route is `/studio`**, not `/admin`. "Studio" is radio-native, reads as
  behind-the-scenes to a non-technical board member, and is short enough to type
  on a phone. `/admin` is a word that tells a scanner it found something.
- **Content and health stats first; listener analytics later.** The app
  currently records *nothing* about listeners — see §2.3.
- **Analytics persist on Coolify Persistent Storage.** Plain JSON rollups under
  the data dir, no database. See §5, which also covers why the volume has to be
  *proven* rather than assumed.
- **This repo is a template.** It will be deployed for other Pacifica stations
  running the same tools, so every storage and configuration decision here is
  judged on "how hard is this to stand up for station number four?" That is what
  §5 is really about.
- **Local and Coolify are named separately at every step.** Storage is the one
  area where a laptop cannot reproduce production even in principle, so every
  definition of done below is split in two — what local proves, and what only a
  redeploy proves. §5.1 is the rule; it is not optional politeness.

---

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

### 2.3 What does not exist

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

`Secure` on the cookie means the studio does not work over plain HTTP. Local dev
is `http://localhost:8080`, which browsers treat as a secure context for
cookies — but verify this early rather than debug it in Phase 2.

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
| `/api/studio/stats` | GET | cookie | Content stats JSON (Phase 2) |
| `/api/studio/health` | GET | cookie | Operational stats JSON (Phase 3) |

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

Also worth doing while we are here: consider dropping the `VOLUME` line from the
Dockerfile entirely. It provides nothing an explicit mount does not, and its only
observable behaviour is the anonymous-volume trap above.

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

### 5.5 Two bugs that would eat analytics data

Both exist today. They cost nothing now because every file under `data/` is
rebuildable; they become data loss the day Phase 5 ships.

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

Neither fix is more than a few lines, and both improve today's behaviour, so
they should not wait for Phase 5.

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
  session cookie, rate limiter, the five routes in §3.4.
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

**Still to do on the deployment:** set `STUDIO_PASSWORD` in Coolify. Until then
production behaves exactly as if the feature does not exist, which is the
intended default.

**Tests** — new `test/studio/` suite: unset-env behaviour, wrong password, backoff, cookie forgery, expiry, logout, direct-file-path probe, and a 401-on-every-API-route sweep. Per §3a, include one test that *strips* the cookie mid-session and requires the probe to notice — an auth suite that can't see failure is worse than none.

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

### Phase 2 — the content dashboard (the mini app)

The visible deliverable. All of it from data already on disk (§2.2).

**Panels**
- **KPI row** — feeds held, episodes in window, total hours, total GB, categories, oldest/newest air date.
- **Top shows** — ranked horizontal bars by hours in window, and by episode count.
- **Category mix** — must survive the 56%/0.2% spread noted in §2.2.
- **Air-date histogram** — episodes per day across the retention window; makes gaps and the weekly rhythm visible at a glance.
- **Duration distribution** — how many shows are 30/60/120 minutes.
- **Coverage** — the 149 / 122 / 115 disagreement, drawn as a funnel: programs known → programs with a feed → programs with harvested detail. Clicking a segment lists the missing ones. This is the panel that will actually change someone's behaviour.
- **Search + sortable table** of every feed: slug, title, items, hours, newest episode, last fetch, last-modified.

**Definition of done** — renders correctly in both themes and follows the toggle live; usable at 375 px; no layout shift on load; every number reproducible by hand from `data/*.json`.

### Phase 3 — operational health

- Feed harvest: last run, 304s, failures, and **which** feeds failed and when (`feedsDiag` currently counts failures but does not name them — a small server change).
- Per-feed staleness: anything not refreshed in N hours.
- Storage: the §5.4 identity fields as a single pass/fail badge — "this volume has persisted for 14 days" or "the volume was replaced on the last deploy" — with `writable` / `feedsOnDisk` as detail beneath. **This is the panel that would have caught the production volume bug in CLAUDE.md §4 the day it started, and it is the panel every new station will need most.**
- Upstream reachability: the existing `probeLiveStream()` plus a light latency record per upstream host.
- Process: uptime, RSS, cache hit/miss on the archive and now-playing caches (needs counters added — trivial, in-memory).

### Phase 4 — actions

Read-only until now. This adds buttons: force a feed re-harvest, refresh the
program directory, re-probe the stream, clear a cache. Write operations, so:
`SameSite=Strict` plus an explicit CSRF token, each action idempotent and
logged, each with a confirmation. Small phase, high satisfaction.

### Phase 5 — listener analytics

Prerequisite: **Phase 1b shipped, and `/healthz` showing a `persistedSince`
that survived a real redeploy on that station.** Not "the volume is configured"
— configured is what we thought last time.

**Collection.** `POST /api/ev` takes a tiny event body — `play` (with show
slug), `live`, `search`, `share`, `pageview`. No cookie, no session, no
identifier, **no IP stored or hashed**. The server increments in-memory counters
and drops the request; there is no event log to leak, because raw events are
never written at all. Rate-limit by shape (a body cap and a per-connection
ceiling) so the endpoint cannot be used to inflate numbers or fill memory.

**Storage.** Aggregates only, one file per month, atomic writes, flushed every
60s when dirty and on shutdown (§5.5). Worst-case loss is one minute.

```jsonc
// $DATA_DIR/stats/2026-07.json
{
  "station": "wbai",
  "month": "2026-07",
  "days": {
    "2026-07-30": {
      "pageviews": 812,
      "plays": { "dn": 44, "housing": 12 },   // by feed slug
      "live": 96,
      "searches": 130,
      "shares": 7
    }
  }
}
```

A month is a few KB. Keep them forever; a decade of this is smaller than one
episode's artwork. The format is deliberately readable — a station operator can
open the file and understand it without us.

**Dashboard.** Plays per day, top shows played, live-vs-archive share, share
counts, and search terms **only above a count threshold** — a rare search string
can identify one person, and a community station is exactly the wrong place to
be careless about that.

**Publish what we count.** A short, plain-language note in the README and on the
studio page itself: what is counted, what is not, and that no listener is
identified or tracked across visits. A station that asks its audience for trust
should be able to state this in three sentences, and this design makes those
sentences true rather than aspirational.

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

1. **The volume is decided but not yet proven.** Persistent Storage in Coolify
   is the answer (§5.3), and §5.4 is how we confirm it rather than assume it.
   The risk that remains is procedural: this has already failed once silently
   here, so **Phase 5 does not start on any station until that station's
   `/healthz` shows a `persistedSince` older than its last deploy.** Content and
   health stats are computed live and are unaffected either way.
2. **`Secure` cookies and local dev.** Verify in Phase 1 that
   `http://localhost:8080` accepts the cookie; if not, key `Secure` off
   `NODE_ENV` and document it.
3. **Password distribution.** An env var in Coolify is fine; the password
   reaching people's phones over SMS is the actual weak link. Worth one line of
   guidance in DEPLOYMENT.md.
4. **Does the studio need to be linked from the app at all?** A menu item makes
   it discoverable to staff and to everyone else. Recommendation: **no link.**
   People who need it can be told the URL once. Revisit if that proves annoying.
5. **Retention framing.** With a 5-item cap per feed, "471 episodes" is a
   snapshot. If the station wants trends over time, that is a *third* kind of
   data — periodic snapshots of our own inventory — written to the same
   `stats/` directory and subject to the same §5.4 prerequisite.
6. **Who holds the password for stations we don't run?** The template hands each
   station its own `STUDIO_PASSWORD`. Nothing in this design lets us into
   theirs, which is correct, but it does mean support means talking someone
   through a `curl` rather than looking ourselves. Worth being deliberate about
   before there are four of these.

---

## 9. Before writing any code

- Confirm the phase-1 scope is what's wanted, and that "no link from the app"
  (§8.4) is right.
- Phase 1b (§5) can go first if the priority is making the template deployable
  rather than getting a dashboard on screen. It is small, it fixes two live
  bugs, and every station benefits whether or not it ever turns the studio on.
- Reread CLAUDE.md §1 and §2: this feature adds new client assets **and** new
  server routes, so both the stale-asset guardrail and the restart-and-verify
  rule are live on almost every commit.
