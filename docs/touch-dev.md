# touch-dev.md — touch audit & modernization plan

Audit date: **2026-07-26**. Scope: `public/index.html`, `public/styles.css`
(1549 lines), `public/app.js` (2347 lines). Nothing here has been implemented
yet — this document is the audit and the plan.

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
| Overlays that lock background scroll | **3 of 6** |
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
| `.player-close` | 30×30 (≤700px) | `1370,1390` | player bar |
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
`CLAUDE.md` §5. Headless Chrome reports `pointer: fine`, so the
`@media (pointer: coarse)` blocks are inert under test — meaning the suite will
**not** catch a coarse-pointer regression. That gap is real; the device
checklist above is the only coverage for it.

---

## 6. Open questions

1. **Which blue square is it?** F1 and F2 are both plausible from the source
   alone. The table in F1 distinguishes them on-device. Both get fixed in
   Phase 1 either way, so this doesn't block — but knowing which one it was
   tells us whether the report is about iOS or Android.
2. **Is this being seen in a Tauri/WebView wrapper?** `docs/TAURI.md` exists.
   Android WebView's default tap highlight is more visible than Chrome's, and
   its `:focus-visible` heuristics differ. Worth knowing which surface the
   report came from.
3. **Does `body{overflow:hidden}` actually hold on the target iOS version?**
   Determines whether F7 needs the full `position:fixed` + scroll-restore
   treatment or just `overscroll-behavior`.
