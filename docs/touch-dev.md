# touch-dev.md — touch audit & modernization plan

Audit date: **2026-07-26**. Scope: `public/index.html`, `public/styles.css`,
`public/app.js`.

**Status: implemented.** All five phases shipped on 2026-07-26, plus a
regression suite at `test/touch/`. The audit below is kept as the record of what
was wrong and why each fix is shaped the way it is. See §7 for what landed.

The trigger was a real user report: *"when tapping on a device there is a blue
square on certain buttons."* That turned out to be the visible tip of a larger
gap — this codebase was built and tuned on a pointer device, and **not one
touch-specific CSS property exists anywhere in it**.

---

## 0. TL;DR

| | |
| --- | --- |
| `-webkit-tap-highlight-color` declarations | **0** |
| `touch-action` declarations | **0** |
| `user-select` / `-webkit-touch-callout` declarations | **0** |
| `:hover` rules | **56**, of which **0** are guarded by `@media (hover:hover)` |
| `@media (hover:none)` blocks | **1** (`styles.css:981`, the sheet-art zoom badge) |
| Interactive controls below the 44×44 CSS px floor | **~20** |
| Overlays that lock background scroll | **3 of 6** (really **0 of 6** — see F7) |
| Text inputs at ≥16px (iOS zoom floor) | **0 of 1** |

The reported blue square is **Finding 1**. Everything else was found while
looking for it.

---

## 1. Method

Static audit, not a device sweep. Three passes:

1. **Grep for the touch surface** — every property a browser consults on a
   touch event (`-webkit-tap-highlight-color`, `touch-action`, `user-select`,
   `-webkit-touch-callout`, `overscroll-behavior`, `env(safe-area-inset-*)`).
2. **Enumerate every interactive element** in `index.html` and every
   dynamically-rendered one in `app.js`, then extract its computed box from
   `styles.css` and measure it against the 44×44 floor.
3. **Read every `:hover` rule** and ask: *if this sticks after a tap and never
   clears, does the UI lie?*

What this audit does **not** cover: real-device testing. Every finding below is
derived from the source; the ones marked **[verify]** need a physical device to
confirm severity. Per `CLAUDE.md` §1, nothing here should be called fixed until
the version stamp proves the browser ran the new code.

---

## 2. Findings

Ordered by severity. Each has the evidence, the mechanism, and the fix.

### 🔴 F1 — The blue square: no `-webkit-tap-highlight-color` anywhere

**Evidence:** `grep -rn "tap-highlight" public/` → zero matches.

**Mechanism.** WebKit and Blink paint an opaque rectangle over the *border box*
of any element that receives a tap, and hold it for the duration of the touch.
The default is UA-specific: iOS Safari uses a translucent grey-blue, Android
Chrome and Android WebView use a light blue. It is drawn as a **rectangle
regardless of `border-radius`** — which is exactly why round buttons like
`.play-btn` (36px circle, `styles.css:760`), `.menu-close` (38px circle,
`:851`), and `.social-btn` (36px circle, `:881`) report as *squares*: the
highlight overflows the circle into its corners.

This is almost certainly the reported bug. It is also why it appears on
"certain buttons" and not others — the effect is most visible on small,
round, dark-on-dark controls, and effectively invisible on large light ones
like `.btn-donate`.

**One ambiguity worth resolving on-device.** There is a second candidate for a
blue square: `:focus-visible{outline:2px solid var(--accent-2); outline-offset:2px}`
(`styles.css:120`). `--accent-2` is `#4fb6ac` in dark mode — a teal-blue — and
`outline` on a rounded element follows the radius in modern engines but with a
2px gap. Tell them apart on the device:

| What you see | It is |
| --- | --- |
| Filled/tinted rect flush to the button edge, gone on release | tap highlight (F1) |
| 2px teal **ring** with a visible gap, persists after release | focus ring (F2) |

Both are addressed below; they are independent bugs.

**Fix.** Do *not* set `-webkit-tap-highlight-color: transparent` globally and
walk away — that removes the only press feedback touch users get and makes the
app feel dead. Kill it **and replace it** with explicit `:active` states (see
F5). Both halves ship together or neither does.

```css
html{ -webkit-tap-highlight-color: transparent; }
```

---

### 🔴 F2 — Focus rings fire on tap, and modals force-focus a close button

**Evidence:** `styles.css:120`, plus programmatic focus at `app.js:2303`
(`closeBtn.focus()`), `app.js:2188` (`sheetClose.focus()`), `app.js:1382`
(`lpToggle.focus()`), `app.js:1843` (`donateClose.focus()`), `app.js:1804`
(`lightboxClose.focus()`).

**Mechanism.** The focus management here is *good* accessibility work — every
overlay moves focus to its close control and restores it on dismiss. But
`:focus-visible` heuristics differ across engines for **programmatic** focus:
Chrome inherits the last input modality (tap → no ring), while Safari has
historically painted the ring anyway. So on iOS, tapping "On Air" opens the
live player and the play button may arrive wearing a teal ring the user never
asked for. Same for the menu drawer, the info sheet, the donate modal, and the
lightbox — the five most-used interactions in the app.

**Fix.** Keep the keyboard ring (it is required); suppress it for coarse
pointers, and keep an explicit ring for `:focus-visible` on fine pointers only.
Do **not** blanket-remove `outline` — that would regress keyboard a11y that
`docs/accessibility.md` deliberately established.

```css
/* keyboard ring stays; touch never sees it */
@media (pointer: coarse){
  :focus:not(:focus-visible){ outline: none; }
}
```

Plus a per-overlay option: focus the close button with `{preventScroll:true}`
and consider `focus()` only when the overlay was opened from the keyboard.
**[verify]** — measure on a real iPhone before changing the JS; the CSS half
may be sufficient.

---

### 🔴 F3 — Every one of the 56 `:hover` rules sticks after a tap

**Evidence:** 56 `:hover` selectors, zero `@media (hover:hover)` guards.

**Mechanism.** Touch browsers synthesize a hover state on tap and hold it until
the user taps elsewhere. Where hover is decorative that is merely ugly; here
several hover rules **encode meaning**, so a stuck hover makes the UI report
something false:

| Rule | Line | What a stuck hover claims |
| --- | --- | --- |
| `.play-btn:hover{background:var(--accent)}` | `765` | Orange fill is also the `.playing` state (`:769`). A tapped-then-stopped row **looks like it is still playing.** |
| `.card-wrap:hover .card-play{opacity:1}` | `1524` | Same conflict — the orange circle is the `.playing`/`.loading` affordance (`:1526-7`). |
| `.card-wrap:hover .card.card-art.play-btn{transform:translateY(-2px)}` | `1461` | Tapped card stays lifted 2px out of the grid. |
| `.row.body:hover{background:var(--surface-hover)}` | `681` | A row stays highlighted as if selected. |
| `.lp-toggle:hover{transform:scale(1.05)}` | `273` | The 64px live play button stays 5% enlarged. |
| `.social-btn:hover{background:var(--accent-2)}` | `886` | Tapped social icon stays filled teal. |
| `.sheet-close` / `.menu-close` / `.lightbox-close` / `.donate-close` `:hover{background:var(--accent)}` | `937,857,1010,1055` | Close buttons stay **red**. |
| `.on-air-btn:hover` shimmer + lift | `179,185` | Sweep animation left mid-state. |
| `.player-range:hover::-webkit-slider-thumb{transform:scale(1.2)}` | `1311` | Scrubber thumb stays enlarged. |

The worst two are `.play-btn` and `.card-play`: they make hover and "playing"
visually identical, so on a phone the listing can show several shows apparently
playing at once.

**Fix.** Wrap every hover rule in a capability query. This is a mechanical but
large edit (56 sites) and should be its own commit with no other changes in it,
so the diff stays reviewable.

```css
@media (hover: hover) and (pointer: fine){
  /* ...all 56 existing :hover rules move in here, unchanged... */
}
```

Two rules already handle this correctly and are the model to follow:
`styles.css:981` (`@media (hover:none)` keeps the sheet-art zoom badge visible)
and the comment at `styles.css:1529` explaining why the card play circle is
hover-only. The pattern exists — it just was never applied broadly.

---

### 🟠 F4 — ~20 controls are below the 44×44 px touch floor

Apple HIG says 44×44pt; Material says 48×48dp; WCAG 2.2 SC 2.5.8 (AA) says
24×24 minimum with spacing. Measured from `styles.css`:

| Control | Size | Line | Notes |
| --- | --- | --- | --- |
| `.link-notice-close` | 26×26 | `1158` | dismiss on the link-notice banner |
| `.lp-alert-dismiss` | 26×26 | `400` | dismiss on the live-stream error alert |
| `.resume-dismiss` | 26×26 | `1338` | dismiss on the resume toast |
| `.view-btn` | 32×28 | `630` | **two of them, 2px apart** (`.view-toggle` gap, `:629`) |
| `.player-close` | 34×34 | `1983` | player bar; glyph only at every width |
| `.player-skip` | 34×34 | `1235` | ±15s; hidden below 420px (`:1248`) |
| `.play-btn` | 36×36 | `760` | **the primary action in every list row** |
| `.social-btn` | 36×36, `.5rem` gap | `881,880` | five in a row in the drawer |
| `.sheet-close` | 36×36 | `930` | info sheet |
| `.menu-close` | 38×38 | `851` | drawer |
| `.lightbox-close` / `.donate-close` | 40×40 | `1003,1044` | close enough; bump for consistency |
| `.player-toggle` | 42×42 | `1250` | play/pause — the most-tapped control in the app |
| `.menu-btn` | 42×42 | `803` | app bar |
| `.on-air-btn` | ~28px tall (≤900px) | `164`, `210` | `padding:.38rem .7rem` |
| `.btn-donate` | ~28px tall (≤900px) | `1202` | same |
| `.refresh-pill` | ~24px tall | `606` | "New shows" |
| `.resume-restart` | ~24px tall | `1330` | "Start over" |
| `.lp-alert-btn` | ~28px tall | `381` | retry / open on wbai.org |
| `.more-link` / `.card-more` | ~15px text | `710`, `1439` | bare inline text, no padding |
| `.player-range` thumb | 12px on a 16px box | `1286,1301` | seek |
| `.lp-volume-range` thumb | 11px on a 14px box | `291,303` | volume |

The two ranges are the sharpest: a 12px thumb inside a 16px-tall hit box is
roughly a quarter of the minimum, and seeking is a *drag*, which is
less forgiving than a tap.

**Fix — expand the hit area, not the ink.** The visual design is deliberate and
should not change. Use a pseudo-element to grow the target invisibly:

```css
.touch-target{ position: relative; }
.touch-target::before{
  content: "";
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  min-width: 44px; min-height: 44px;
  width: 100%; height: 100%;
}
```

Applied to the small round buttons this costs zero pixels of layout. The two
sliders instead want a taller transparent hit box plus a larger thumb *on
coarse pointers only*:

```css
@media (pointer: coarse){
  .player-range, .lp-volume-range{ height: 44px; }
  .player-range::-webkit-slider-thumb{ width: 20px; height: 20px; margin-top: -8px; }
  .lp-volume-range::-webkit-slider-thumb{ width: 18px; height: 18px; margin-top: -7px; }
}
```

Note the `.view-toggle` pair needs spacing as well as size — WCAG 2.5.8 counts
adjacent targets, and 2px between two 32px buttons will produce mis-taps.

**Superseded (2026-07-27).** Widening the gap was the wrong lever: the gap is a
dead strip owned by neither button, and taps aimed at the seam landed on
`.view-toggle` itself, where the click handler's `closest('.view-btn')` returns
null and the tap is silently dropped. Shipped instead: `gap: 0` with wider
segments — `46x32` on desktop, `58x44` on coarse pointers. WCAG 2.5.8 is
satisfied by size alone once a target clears 24x24, so zero spacing is
conformant here.

---

### 🟠 F5 — No press feedback on most controls (blocks F1)

**Evidence:** only 7 `:active` rules exist — `.on-air-btn:active` (`188`),
`.btn-donate:active` (`473`), `.lp-toggle:active` (`274`), `.lp-alert-btn:active`
(`391`), `.refresh-pill:active` (`619`), `.player-skip:active` (`1243`),
`.player-close:active` (`1385`), `.donate-close:active` (`1056`).

**Mechanism.** On a pointer device, hover *is* the feedback, so the missing
`:active` states never mattered. On touch there is no hover — the only feedback
today is the UA tap highlight from F1. Remove that highlight without adding
`:active`, and the app becomes unresponsive-feeling: taps register but nothing
acknowledges them, which reads as "the button is broken" and produces
double-taps.

**Fix.** Ship a uniform press state alongside the F1 change. Scale is the
cheapest signal that works on any background:

```css
@media (hover: none){
  button:active, a:active, [role="button"]:active{
    transform: scale(.96);
    transition: transform .06s ease;
  }
}
@media (prefers-reduced-motion: reduce){
  button:active, a:active, [role="button"]:active{ transform: none; opacity: .7; }
}
```

The reduced-motion fallback matters: this repo already honors
`prefers-reduced-motion` in 12 places, and a scale transform is exactly the kind
of thing that guard exists for.

---

### 🟠 F6 — iOS zooms the page when the search field is focused

**Evidence:** `styles.css:538` — `.search-field input{ font-size:.95rem }` =
15.2px. `index.html:68` is the only text input in the app.

**Mechanism.** Mobile Safari auto-zooms on focus of any `<input>` whose computed
font-size is under **16px**, then leaves the viewport zoomed after blur. The
sticky app bar (`.appbar`, `position:sticky`) and sticky search bar
(`.row.head{top:121px}`, `:675`) misalign while zoomed. On a phone this is the
first thing a user touches.

**Fix.** Do **not** add `user-scalable=no` to the viewport meta — that fixes the
symptom by disabling pinch-zoom for everyone and fails WCAG 1.4.4. Set the
input to 16px on coarse pointers instead:

```css
@media (pointer: coarse){ .search-field input{ font-size: 16px; } }
```

While in there, the search field is missing mobile keyboard hints:
`inputmode="search"`, `enterkeyhint="search"`, `autocorrect="off"`,
`autocapitalize="off"`, `spellcheck="false"`. Cheap, and they change what
keyboard the OS shows.

---

### 🟡 F7 — Lightbox and donate modal don't lock background scroll

**Evidence:** `styles.css:844` (`body.menu-open{overflow:hidden}`) and `:926`
(`body.sheet-open{overflow:hidden}`) are the only two scroll locks.
`openLightbox()` (`app.js:1797`) and `openDonate()` (`app.js:1835`) add **no**
body class. `openLivePlayer()` (`app.js:1380`) borrows `sheet-open` and is fine.
The live-stream error alert (`paintLiveAlert()`, `app.js:968`) also has a scrim
and no lock, but it only ever appears over the already-locked live player.

**Mechanism.** Both are full-screen overlays with a backdrop. With no lock, a
vertical drag on the overlay scrolls the listing behind it. The donate modal is
worse: it wraps an `<iframe>`, so the drag may scroll the page, the iframe, or
neither depending on where it started.

Related: **no `overscroll-behavior` anywhere.** The four scrollable panels —
`.live-player` (`:224`), `.lp-alert` (`:346`), `.menu-links` (`:861`),
`.sheet-body` (`:941`) — all chain their scroll to the document when they hit
an end, producing the classic "I scrolled the modal and the page moved" bounce.

Also worth knowing: `body{overflow:hidden}` alone is historically unreliable on
iOS Safari. The `overscroll-behavior:contain` addition below is the part that
actually holds. **[verify]** on iOS 17+ before investing in a
`position:fixed` + scroll-restore rewrite.

**Fix.**

```css
body.lightbox-open, body.donate-open{ overflow: hidden; }
.live-player, .lp-alert, .menu-links, .sheet-body{ overscroll-behavior: contain; }
```

…plus the matching `classList.add/remove` in `openLightbox`/`closeLightbox` and
`openDonate`/`closeDonate`.

#### ⚠️ Correction (2026-07-27): that fix was a no-op. All six leaked.

The premise above — that `body.menu-open` and `body.sheet-open` were "the only
two scroll locks", i.e. two that worked — was wrong. **None** of them worked,
including the two that predate this audit, and the two added by this fix joined
them. Measured with a real touch scroll gesture through the compositor: the page
scrolled behind the sheet, the lightbox, the donate modal, the menu drawer and
the live player alike.

**Why.** The viewport takes its overflow from `<body>` *only* when the root's
overflow computes to `visible`. F-something-else in this very audit added
`html{overflow-x:clip}` to contain the off-canvas drawer — which makes it
not-visible, so `<html>` became the scroll container and every
`body{overflow:hidden}` stopped propagating. Body's height is its content, so
there was nothing for it to clip either. Two correct-looking declarations,
zero effect.

**Actual fix.** `html.scroll-lock{ overflow:hidden; overscroll-behavior:none; }`,
toggled on `document.documentElement` by `refreshOverlayState()` in `app.js` —
the same function that manages background `inert`, so one place owns "is any
overlay up?" and nested overlays can't unlock early. The body classes stay as
dead-but-harmless second line of defence. Scrims also get
`touch-action:pinch-zoom` (not `none` — pinch-zoom is deliberately preserved).

**How it hid for so long.** `test/touch` asserted
`getComputedStyle(document.body).overflow === 'hidden'`. That was true the whole
time. The suite now uses `p.pageScrolls()` (`test/live-stream/cdp.js`), which
synthesizes a real touch scroll gesture. Three further traps were found while
making that probe trustworthy, all recorded in `CLAUDE.md` §3a:

- Assigning `scrollTop` *does* move a correctly locked page — `overflow:hidden`
  blocks input scrolling, not programmatic scrolling. The obvious replacement
  probe was as wrong as the one it replaced.
- **One probe point is not a measurement.** Whether a drag reaches the document
  depends on what is under the finger. Measured with the info sheet deliberately
  unlocked: a gesture at (195,500) lands on `.sheet-body`
  (`overscroll-behavior:contain`) and does *not* move the page, while (195,800)
  lands on the footer and moves it 300px. A single mid-screen probe would have
  passed a wide-open leak. `pageScrolls()` now sweeps five points.
- `p.click()` calls `scrollIntoView()` first, so any test measuring scroll
  position around a click measures the harness. `p.clickInPlace()` throws
  instead. This cost real time chasing a phantom "500 → 163 jump on sheet open"
  that the app had nothing to do with.

**Coverage limit, stated plainly.** At the 390px viewport this suite emulates,
`.donate-modal` is `100vw × 100dvh` with the cross-origin iframe filling it, so
every gesture lands on the iframe and can never reach the parent document —
verified: the gesture half reports "held" there even with no lock at all. That
one assertion is carried by the marker-class check, not by behaviour. Its
behavioural half only bites at desktop widths, where the modal is a 940px card
with scrim around it. Of the five overlays the suite drives, the gesture sweep
independently catches the regression on four.

**And the suite now proves it can still fail.** Every assertion here is of the
form "the page did NOT move", which passes perfectly once the probe goes blind —
exactly how the computed-style version survived. So section 4 strips the lock
mid-run, with the sheet still open, and requires the probe to notice. If that
self-test fails, every other PASS in the section is worthless.

---

### 🟡 F8 — Long-press fires iOS text-selection and image callouts

**Evidence:** no `user-select` or `-webkit-touch-callout` in the codebase.

**Mechanism.** Two distinct annoyances:

- **Text selection on buttons.** `.show-open` (`:693`), `.card-overlay`
  (`:1486`), `.player-info` (`:1264`) and the sort buttons wrap real text
  inside a `<button>`. A long-press — or a tap that drifts a few pixels —
  starts a selection and pops the Copy/Look Up callout instead of activating
  the control.
- **Image save sheet on artwork.** `.show-thumb img` (`:723`), `.player-art img`
  (`:1261`), `.card-art`, `.sheet-art img` — long-pressing any of them opens
  iOS's "Save Image / Copy / Share" sheet over the app.

The lightbox (`app.js:1797`) is the intentional place to interact with artwork;
the thumbnails are buttons and should behave like buttons.

**Fix.**

```css
button, [role="button"], .show-open, .card-overlay, .player-info{
  -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none;
}
.show-thumb img, .player-art img, .card-art img{
  -webkit-touch-callout: none; -webkit-user-drag: none;
}
```

Deliberate exception: leave `user-select` alone on the info sheet body — show
descriptions are text users legitimately want to copy. Scope the rule to
controls, never to `body`.

---

### 🟡 F9 — No `touch-action`; rapid double-taps trigger zoom

**Evidence:** zero `touch-action` declarations.

**Mechanism.** The viewport is correctly responsive (`index.html:5`,
`width=device-width, initial-scale=1`), so the legacy 350ms click delay is gone.
What remains is **double-tap-to-zoom**: two taps inside ~300ms on the same
element zoom the page instead of firing two clicks. The controls this hits are
exactly the ones users tap repeatedly:

- `.player-skip` ±15s (`:1235`) — skipping 30s is two fast taps
- `.player-toggle` (`:1250`) — pause/resume corrections
- `.view-btn` list/gallery (`:630`) — toggling back and forth
- `.play-btn` (`:760`) — impatient re-taps while a stream buffers

`touch-action: manipulation` disables double-tap zoom on the element while
leaving pan and pinch-zoom intact — it does not cost accessibility.

The two `<input type=range>` sliders want the opposite treatment:
`touch-action: none` so a horizontal drag on the scrubber seeks instead of
being stolen by the page's vertical pan gesture.

**Fix.**

```css
button, a, [role="button"], summary, label{ touch-action: manipulation; }
.player-range, .lp-volume-range{ touch-action: none; }
```

---

### 🟡 F10 — Safe-area insets are partial

**Evidence:** `env(safe-area-inset-bottom)` appears 3 times — `styles.css:421`
(live player on phones), `:1179` (`.sheet-foot`), `:1232` (`.player-bar`).
`index.html:15-17` sets `apple-mobile-web-app-capable` and
`black-translucent` status bar.

**Gaps.**

- **`viewport-fit=cover` is missing** from the viewport meta. Without it,
  `env(safe-area-inset-*)` resolves to **0** on iOS — meaning all three
  existing insets are currently no-ops. This one line makes the work already
  done start functioning.
- `black-translucent` puts content **under** the status bar, but `.appbar`
  (`:123`) has no `padding-top: env(safe-area-inset-top)` — the app bar will sit
  under the notch when installed to the home screen.
- The right-side drawer (`.menu-panel`, `:830`) has no
  `padding-right: env(safe-area-inset-right)` for landscape.
- `min-height:100vh` on `body` (`:105`) is the old unit; `100dvh` accounts for
  the collapsing mobile URL bar. The rest of the sheet is already on `dvh`
  (`:226,348,419,832,910,928,1060,1173`) — `body` is the straggler.

**Fix.**

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```
```css
body{ min-height: 100dvh; }
.appbar{ padding-top: env(safe-area-inset-top, 0px); }
.menu-panel{ padding-right: env(safe-area-inset-right, 0px); }
```

---

### 🟢 F11 — Smaller items

- **`-webkit-text-size-adjust` unset.** iOS inflates text on
  portrait→landscape rotation. `html{ -webkit-text-size-adjust: 100%; }`.
- **`format-detection` unset.** iOS auto-links number-shaped strings; show
  titles and the `.cell-date` / `.retention` columns are full of digits, and each
  autolink becomes a stray tap target inside a button.
  `<meta name="format-detection" content="telephone=no">`.
- **`title` attributes on touch-only-reachable controls.** `index.html:93,96`
  (view toggle), `:331,337,340` (transport) carry `title` tooltips that never
  render on touch. Harmless — `aria-label` is present on all of them — but they
  are not the affordance they look like.
- **`.card-date` is correctly `pointer-events:none`** (`:1541`) so the badge
  doesn't eat taps. Good; the same treatment should be confirmed for
  `.retention` and `.card-eyebrow`.
- **`.card-more` has `tabindex="-1"`** (`app.js:412`, styled `styles.css:1439`)
  and sits at `z-index:5` over `.card-overlay` at `z-index:4` — a ~15px-tall text target layered on a
  larger one. Either grow it (F4) or drop it on coarse pointers, since the whole
  card already opens the sheet.

---

## 3. What we are deliberately NOT doing

Recording these so they don't get "fixed" later by someone reading only the
findings:

| Not doing | Why |
| --- | --- |
| `user-scalable=no` / `maximum-scale=1` | Fixes F6 by breaking pinch-zoom for everyone. WCAG 1.4.4 failure. The 16px input rule is the correct fix. |
| Global `outline: none` | Would undo the keyboard focus work in `docs/accessibility.md`. F2 scopes the removal to coarse pointers only. |
| `touchstart`-based click handling | All 34 handlers in `app.js` are `click`, which is correct and already fast under a responsive viewport. Swapping to `touchstart` reintroduces ghost clicks and breaks keyboard activation. |
| Custom swipe-to-dismiss gestures | Tempting for the bottom sheet, but it means owning a gesture arbiter next to the audio scrubber. Not worth the regression surface — see `docs/big-audio-bug.md` for how that goes here. |
| Global `user-select: none` on `body` | Show descriptions in the info sheet are meant to be selectable. F8 scopes it to controls. |
| Removing the tap highlight without adding `:active` | F1 and F5 ship together. Half of this change is worse than none of it. |

---

## 4. Plan

Five commits, ordered so each is independently verifiable and independently
revertable. Phase 1 alone resolves the reported bug.

### Phase 1 — the reported bug + the base layer *(one commit)*

New `/* ===== Touch base layer ===== */` block near the top of `styles.css`,
right after the `:focus-visible` rule at `:120` so it reads as part of the
interaction baseline:

```css
html{
  -webkit-tap-highlight-color: transparent;   /* F1 */
  -webkit-text-size-adjust: 100%;             /* F11 */
}
button, a, [role="button"], summary, label{
  touch-action: manipulation;                 /* F9 */
}
.player-range, .lp-volume-range{ touch-action: none; }
button, [role="button"], .show-open, .card-overlay, .player-info{
  -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none;                /* F8 */
}
.show-thumb img, .player-art img, .card-art img{
  -webkit-touch-callout: none; -webkit-user-drag: none;
}
@media (pointer: coarse){
  :focus:not(:focus-visible){ outline: none; } /* F2 */
  .search-field input{ font-size: 16px; }      /* F6 */
}
@media (hover: none){                          /* F5 */
  button:active, a:active, [role="button"]:active{
    transform: scale(.96); transition: transform .06s ease;
  }
}
@media (prefers-reduced-motion: reduce){
  button:active, a:active, [role="button"]:active{ transform: none; opacity: .7; }
}
```

Covers **F1, F2, F5, F6, F8, F9, F11**. No visual change on desktop, no layout
change anywhere.

**Also in this commit:** add the three `Emulation.*` calls from §5 to
`test/live-stream/run-tests.js`. They go in first, before any coarse-pointer CSS
exists, so the suite is watching the new rules from the moment they land rather
than being retrofitted after a regression. Run `./run.sh` and `./run.sh --strict`
both before and after the CSS change — the pair should pass identically, which
is what proves the emulation didn't disturb the existing live-audio scenarios.

### Phase 2 — hover containment *(one commit, nothing else in it)*

Wrap all 56 `:hover` rules in `@media (hover: hover) and (pointer: fine)`.
Mechanical and large; keeping it alone keeps the diff readable. Verify
specifically that `.play-btn` and `.card-play` no longer share a look with
`.playing`. Covers **F3**.

### Phase 3 — hit targets *(one commit)*

Add the `::before` expansion helper and apply it to the ~20 controls in the F4
table; widen the two sliders under `@media (pointer: coarse)`; increase
`.view-toggle` gap. Covers **F4**.

### Phase 4 — overlays and viewport *(one commit)*

`viewport-fit=cover` + `format-detection` in `index.html`;
`overscroll-behavior: contain` on the four scroll panels; `lightbox-open` /
`donate-open` body classes in `app.js` plus their CSS; `body{min-height:100dvh}`;
safe-area padding on `.appbar` and `.menu-panel`. Covers **F7, F10**.

### Phase 5 — polish *(one commit)*

Search-field input hints (`inputmode`, `enterkeyhint`, `autocorrect`,
`autocapitalize`, `spellcheck`); `.card-more` sizing decision; audit remaining
overlay badges for `pointer-events`. Covers the rest of **F11**.

---

## 5. Verification

`public/*` changes need **no server restart** (`CLAUDE.md` §2) — but per
`CLAUDE.md` §1 they absolutely need a version check, because judging touch
behavior against a stale bundle is precisely the trap this repo has already lost
hours to.

After each phase:

1. `curl -s localhost:8080/healthz` → note `version`.
2. Reload on the device. Confirm the page's `X-App-Version` matches step 1.
   **If it doesn't, stop — nothing observed is valid.**
3. Only then run the checklist.

Per-phase checks, on a real iOS device and a real Android device:

| Phase | Check |
| --- | --- |
| 1 | Tap `.play-btn`, `.menu-close`, `.social-btn` — **no blue/grey square**. A ~4% shrink acknowledges each press. Focus the search field — page does **not** zoom. Double-tap `.player-skip` fast — skips 30s, no page zoom. Long-press a `.show-thumb` — no "Save Image" sheet. |
| 2 | Tap a row's play button, then stop playback — the button returns to neutral, not orange. Tap a gallery card — it does not stay lifted with a stuck play circle. |
| 3 | Every control in the F4 table is tappable at its edge without hitting a neighbor. Drag the scrubber and the volume slider with a thumb, not a fingernail. |
| 4 | Open the lightbox and the donate modal, drag vertically — the listing behind does **not** move. Install to home screen: app bar clears the notch, player bar clears the home indicator. |
| 5 | Search field shows a keyboard with a "Search" return key and no autocapitalize. |

**Regression guard.** `test/live-stream/` drives the unmodified app in headless
Chrome. Phase 1 touches `touch-action` and `user-select` on `.lp-toggle` and the
volume slider, and Phase 3 resizes `.lp-volume-range` — both are inside the live
player. Run **both** `./run.sh` and `./run.sh --strict` after Phases 1 and 3, per
`CLAUDE.md` §5.

**The harness is fine-pointer today, and that is fixable — do it in Phase 1.**
Headless Chrome reports `pointer: fine` / `hover: hover`, so every
`@media (pointer: coarse)` and `@media (hover: none)` block this plan adds would
be inert under test. Three CDP calls fix it, and `cdp.js` already speaks raw
CDP, so this is additive — no new dependency, no change to the app:

```js
await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await p.send('Emulation.setEmulatedMedia', { features: [
  { name: 'pointer',     value: 'coarse' }, { name: 'any-pointer', value: 'coarse' },
  { name: 'hover',       value: 'none'   }, { name: 'any-hover',   value: 'none'   }
]});
await p.send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
```

Order matters: emulate **before** `Page.navigate`, not after.

**Verified on 2026-07-26**, not assumed. The check used
`.sheet-art-zoom-badge`, whose only `@media (hover:none)` rule already ships at
`styles.css:981` — so it measures the real stylesheet with nothing injected:

| Run | `matchMedia('(hover:none)')` | computed `opacity` |
| --- | --- | --- |
| headless default | `false` | `0` — rule does **not** apply |
| with the three calls above | `true` | `1` — rule **does** apply |

So CDP media emulation reaches real CSS style resolution, not just
`matchMedia`. Coarse-pointer CSS **is** testable here.

**One trap that cost a round of false results.** The app is served under
`Content-Security-Policy: style-src 'self'` (no `'unsafe-inline'`). Injecting a
probe `<style>` from `Runtime.evaluate` is **silently blocked** — the rule never
applies and the test looks like an emulation failure when it is really a CSP
failure. Assert against rules that already ship in `styles.css`, never against
injected ones. (The same applies to `script-src 'self'`.)

**What this still does not cover**, and where the device checklist remains the
only coverage: emulation gives Chrome's *rendering* of a coarse pointer, not
iOS Safari's *behavior*. It cannot confirm F1 (the UA tap highlight is
Safari/WebView-specific), F2 (Safari's `:focus-visible` heuristic on
programmatic focus), F6 (Safari's 16px zoom trigger), F8 (the iOS long-press
callout), or F10 (`env(safe-area-inset-*)`, which is 0 in a desktop viewport).
Emulation covers the *CSS wiring*; the device covers the *engine behavior*.

---

## 6. Verified on implementation

Three things were open when this was written. Two were answered by building it;
the third needs no answer.

1. **Which blue square was it?** Both were real and both are fixed. The tap
   highlight (F1) is now `transparent`, asserted by `test/touch/`; the focus
   ring (F2) no longer fires on coarse pointers. No device triage was needed —
   fixing both is correct regardless of which one the report saw.
2. **Tauri?** Not a factor. Nothing has been built with Tauri; `docs/TAURI.md`
   is planning only. The fixes are plain web-platform CSS and apply to any
   surface the app is loaded in.
3. **Does `body{overflow:hidden}` hold on iOS?** `overscroll-behavior: contain`
   was added to all four scroll panels alongside the lock, which is the part
   that actually holds a modal's scroll on iOS. If a device ever shows the page
   still moving behind an overlay, the escalation is `position:fixed` +
   scroll-restore — but that is a bigger change than the problem currently
   justifies.

---

## 7. What shipped

| Phase | Change | Where |
| --- | --- | --- |
| 1 | Touch base layer: tap highlight, `touch-action`, `user-select`/callout, text-size-adjust | `styles.css` after `:focus-visible` |
| 1 | Coarse-pointer focus rings off; search input 16px | `styles.css` (end of file) |
| 1 | `:active` press feedback + reduced-motion fallback | `styles.css` base layer |
| 2 | **52** `:hover` rules wrapped in `@media (hover:hover) and (pointer:fine)` | throughout `styles.css` |
| 3 | Hit targets to 44px — `::before` for isolated controls, real box for adjacent ones | `styles.css` (end of file) |
| 3 | Scrubber: 30px press band at 16px layout cost (see below) | `styles.css` (end of file) |
| 4 | `viewport-fit=cover`, `format-detection` | `index.html` |
| 4 | `lightbox-open` / `donate-open` scroll locks | `app.js` + `styles.css` |
| 4 | `overscroll-behavior:contain` ×4, safe-area padding, `100dvh` | `styles.css` |
| 5 | Search field mobile keyboard hints | `index.html` |
| — | Touch regression suite, 28 assertions | `test/touch/` |

### Two things worth knowing before editing this again

**Source order, not specificity, decides the coarse-pointer overrides.** Media
queries add no specificity. The `@media (pointer: coarse)` blocks live at the
**end** of `styles.css` for that reason — placed with the rest of the base layer
near the top, `.menu-btn{width:44px}` silently lost to the plain
`.menu-btn{width:42px}` declared 700 lines later. The test suite caught exactly
this on the first run (`.menu-btn → 42x42`, `.view-btn → 32x28`,
`#q → 15.2px`). If you add a coarse override, add it at the bottom.

**The scrubber is a measured compromise, not a rounded-up number.** The obvious
fix — `.player-range{height:44px}` — was implemented first and then measured:
it produced an **88px player bar = 10.4% of a 390x844 phone**, permanently, on
every screen while playing. Spotify's and Apple Music's mini-players sit around
64px. The shipped version instead grows the hit band with negative margins that
eat only dead space (the 6px gap above and the bar's own bottom padding), never
`.player-info` above it, which is a button:

```css
.player-range{ height: 30px; margin-top: -6px; margin-bottom: -8px; }
```

30px to press, 16px of layout, **bar back to 68px (8.1%)**. This works because a
range input only needs the tall band for the *initial* press — once the drag
starts it tracks horizontally no matter where the finger wanders vertically.
The volume slider inside the live-player modal keeps a full 44px, because there
it costs nothing.

`test/touch/` §5 asserts both halves: the band stays >= 28px AND the bar stays
under 12% of the screen. Growing the band by growing the bar would satisfy a
naive size check while quietly costing a tenth of the phone.

**The hover guard splits selector lists; keep it that way.** `.card-play`'s
`opacity:1` was shared by four selectors — `:hover`, `:focus-visible`,
`.playing`, and `.loading`. Only the `:hover` one moved inside the guard. Moving
the whole block would have disabled the play indicator on touch, which is the
opposite of the bug being fixed.

---

## 8. Running the suite

```sh
node server.js &          # app must be on :8080
./test/touch/run.sh       # 28 assertions, coarse-pointer emulated
```

It runs both ways on purpose: pass 1 asserts the hover guards **do** match on a
fine pointer (so desktop hover is not silently dead), pass 2 asserts they **do
not** match on a coarse one. A regression in either direction fails.

`test/live-stream/` is unaffected — the touch suite is a separate harness with
its own Chrome profile, so `./run.sh` and `./run.sh --strict` there keep testing
live audio exactly as before. Run those too after touching `styles.css`; the
live player's toggle and volume slider are both inside the touch changes.

**Never run the two suites at the same time.** They were briefly on the same
remote-debugging port, and the failure mode is genuinely confusing: the second
Chrome cannot bind the port, so `cdp.js connect()` silently attaches to the
*first* suite's browser and drives it — navigating it away from the app and
resizing it to 390x844 mid-run. The live-stream suite then failed with
`element covered: #lpClose — none is on top`, which reads exactly like a CSS
regression and is not one. Two guards now: this suite uses port **9223**, and
its profile is `chrome-profile-touch`. Note that live-stream's cleanup runs
`pkill -f "chrome-profile"`, which still matches that name — so run them one at
a time regardless.

**The CSP trap.** The app is served `style-src 'self'` with no `'unsafe-inline'`.
A probe `<style>` injected from `Runtime.evaluate` is silently blocked — it
looks identical to an emulation failure and cost a full round of false
conclusions while building this. Assert against rules that already ship in
`styles.css`, never against injected ones.

### What the suite still cannot cover

Emulation gives Chrome's *rendering* of a coarse pointer, not iOS Safari's
*behavior*. It cannot confirm the UA tap-highlight colour on WebKit, Safari's
`:focus-visible` heuristic for programmatic focus, Safari's 16px zoom trigger,
the iOS long-press callout, or `env(safe-area-inset-*)` (0 in a desktop
viewport). The suite proves the CSS is wired and live; a phone proves the engine
behaves. Both fixes are standard and low-risk, so this is a confirmation gap,
not a correctness risk.
