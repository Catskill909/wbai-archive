# Accessibility — research & planning

Status: **research / planning** (nothing here is a committed spec yet).
Scope: the front-end in `public/` (`index.html`, `app.js`, `styles.css`).
Target: **WCAG 2.2 Level AA** as the working bar.

---

## TL;DR — custom or packages?

**Stay custom.** This repo's whole shape argues for it, and the accessibility
work is nearly done anyway:

- It is a **zero-dependency, no-build** app (see `CLAUDE.md` §4). Adding an npm
  a11y runtime (Reach UI, Radix, Headless UI, a focus-trap library, etc.) would
  mean adopting a bundler, a framework, or both — a much bigger change than the
  handful of gaps left to close.
- Those libraries are written for React/Vue component trees. We render HTML from
  vanilla string templates, so they don't drop in.
- **The hard parts already exist and work**: focus traps, return-focus, `Escape`
  to close, a roving-tabindex listbox, a skip link, `:focus-visible` rings, and
  `prefers-reduced-motion` throughout. A library would replace working code with
  a dependency, not add a missing capability.

So: **custom for anything that ships to the browser.** Do lean on packages for
**tooling** — they run in dev/CI, never in the bundle (see [Testing](#testing)).

---

## What's already in place (audit, 2026-07)

The codebase is in good shape. Confirmed present:

| Area | Evidence |
| --- | --- |
| Skip link | `index.html:24`, styled `styles.css:111` (off-screen until `:focus`) |
| Landmark structure | `<header>`, `<main>`, `<nav>`, `<aside>` used semantically |
| Visually-hidden `<h1>` for document outline | `index.html:60`, `.visually-hidden` `styles.css:115` |
| Focus-visible rings | global `:focus-visible` `styles.css:120`, plus per-control rules |
| Reduced-motion support | 23 `@media (prefers-reduced-motion: reduce)` blocks in `styles.css` (as of 2026-07-30) |
| Modal focus trap + return focus | live player `app.js:1003–1043`, sheet `:1662–1725`, menu `:1769–1798`, lightbox `:1343–1359` |
| `Escape` closes every overlay | menu, sheet, lightbox, live player, category menu |
| Custom listbox w/ keyboard | category dropdown: Arrow/Home/End/Escape, `role="listbox"`/`option`, `aria-selected` (`app.js:137–187`) |
| ARIA on controls | `aria-label`, `aria-pressed`, `aria-expanded`, `aria-haspopup`, `aria-controls` throughout |
| Dialog semantics | `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on sheet/live/lightbox |
| Redundant controls kept out of tab order | duplicate art buttons `tabindex="-1"` + `aria-hidden` (`app.js:333`, `index.html:293`) |
| Meaningful alt / decorative hiding | logos have `alt`; every inline SVG icon is `aria-hidden="true"` |
| `color-scheme` + theme-color | `index.html:8–13` |
| Loading state announced | `role="status" aria-live="polite"` on `#loadingState` (`index.html:117`) |

This is already above the median web app. The plan below is about closing
specific, known gaps — not a rebuild.

### Show modal follow-up (local prototype, 2026-08-12)

The routed Show/Past episodes prototype was checked separately because it adds
navigation and transport inside the existing dialog:

- the dialog's `aria-labelledby` follows the visible Show or Past episodes route;
- visible Back returns to Show view, while Close/minimize leaves the dialog;
- Escape follows that same hierarchy and Tab remains trapped in the one dialog;
- archive row details and Play are sibling buttons with distinct accessible
  names—selection never masquerades as playback;
- partial and completed listening state is written in words as well as drawn;
- `Playing`, `Paused`, and `Loading` changes update the row's accessible name;
- internal Back and in-modal player controls meet the 44px coarse-pointer floor;
- the modal player dock retains transport while profile/archive content changes;
- the primary action's accessible name includes its date and `instead` when it
  would replace different loaded audio;
- dock artwork is decorative while the adjacent text supplies show/date identity;
- the teal equalizer has written `Playing now` state, appears only during actual
  playback, and becomes static under reduced motion;
- short viewports receive a real `More show information`/`More episodes` button
  only while content remains below the scroll body, instead of relying on a
  visual fade alone.

The browser regression is `test/episode-rail/run.sh` (72 checks after the
secondary audit). This is automated evidence, not a replacement for the manual
screen-reader, zoom/reflow, and forced-colors passes below.

**The studio** (`/studio`, added 2026-07-30) is held to the same bar and audited
separately, because it is a different document with its own markup:

| Area | Evidence |
| --- | --- |
| Landmark structure | `<header>` / `<main>` on the dashboard, `<main>` on the login page |
| Labelled input | real `<label>` wrapping the password field, `autocomplete="current-password"` |
| Errors announced, not just drawn | `role="alert"` + `aria-live="polite"` on both error slots, `hidden` until there is something to say |
| Loading state | `aria-busy` on `<main>`, cleared when the first payload renders |
| Focus-visible rings | `.studio-btn:focus-visible` and `.studio-input:focus-visible` |
| Touch targets | `min-height: 2.75rem` on buttons (WCAG 2.2 § 2.5.8) |
| Theme control on every page | shares `theme-boot.js`, so a saved preference applies before first paint — no flash |
| Status not conveyed by colour alone | the storage verdict states the outcome in words; the coloured dot only reinforces it |
| Reduced motion | honoured via the shared token set and an explicit block in `studio.css` |
| No zoom trap on iOS | input font-size pinned to 1rem/16px |
| Action buttons | real `<button>`s, `min-height: 2.75rem`, `:focus-visible` rings, disabled while running so a second press cannot queue |
| Action results announced | `role="status" aria-live="polite"` on the result line, so the outcome reaches a screen reader rather than only appearing |
| Charts are not colour-only | every bar row is focusable with an `aria-label` carrying label and value; the day histogram is `role="img"` with a summary naming its range, peak and empty-day count, and every number is also in the sortable table |

---

## Gaps & candidate work

Roughly ordered by impact ÷ effort.

### 1. Background not made inert when an overlay is open  ·  High impact  ·  ✅ DONE (2026-07-25)
**Implemented.** A shared `refreshOverlayState()` helper (`app.js`, near the DOM
refs — named `refreshBgInert()` until 2026-07-27) toggles the `inert` attribute
on `.appbar` + `main#top` whenever any overlay carries `.show`, and since
2026-07-27 also owns the background scroll lock (`html.scroll-lock`; see
`touch-dev.md` F7). Wired into all open/close pairs (menu, sheet, lightbox,
donate, live player). Reads real `.show` state rather than counting, so nested
cases (lightbox over sheet, sheet→live handoff) stay correct. Still needs a
screen-reader pass to confirm the background is truly unreachable by the virtual
cursor. Original notes below.


Modals trap the **Tab** key in JS, but the rest of the page is still in the
accessibility tree. A screen-reader user swiping/virtual-cursoring (not tabbing)
can still land on the listing behind an open sheet or menu.

- **Fix:** when an overlay opens, mark the background (`<header>` + `<main>`, or
  a wrapper) with the `inert` attribute; remove it on close. `inert` is
  baseline-supported in modern browsers and removes an element and its subtree
  from focus **and** the a11y tree in one step — replacing the hand-rolled Tab
  wrap entirely if we want.
- Files: `app.js` open/close handlers (`openSheet`/`closeSheet`,
  `openMenu`/`closeMenu`, `openLivePlayer`/`closeLivePlayer`, lightbox).
- **Also consider** migrating the custom dialogs to the native `<dialog>`
  element + `showModal()`, which gives inert-background, `Escape`, and the top
  layer for free. Larger change; evaluate against the working custom code before
  committing.

### 2. Search results aren't announced  ·  High impact  ·  ✅ DONE (2026-07-25)
**Implemented.** `#resultCount` now carries `role="status" aria-live="polite"`
(`index.html`). All count/status text already routes through that one element
("42 shows found", "Loading shows…", "Could not load the archive."), so filtering
and load states now announce. `polite` naturally coalesces rapid typing — no
debounce added. Needs a screen-reader pass to confirm cadence isn't chatty.
Original notes below.


`#resultCount` (`index.html:82`) is updated as the user types/filters, but it's
not a live region, so screen-reader users get no feedback that the list changed
size. `#emptyState` is toggled with `hidden` but also isn't announced.

- **Fix:** add `role="status" aria-live="polite"` to the result-count element
  (or a dedicated visually-hidden live region) and write e.g. "42 shows" /
  "No shows match" into it after each filter. Debounce so rapid typing doesn't
  spam the announcement.
- Files: `index.html:80–95`, the render/filter path in `app.js`.

### 3. Windows High Contrast / forced-colors  ·  Medium impact
Zero `@media (forced-colors)` or `prefers-contrast` rules today. In Windows High
Contrast Mode, custom colors are overridden by the system palette; icon-only
buttons and outline rings can vanish or lose meaning.

- **Fix:** add a `@media (forced-colors: active)` pass — use `SystemColors`
  keywords (`CanvasText`, `Highlight`, `ButtonText`), ensure focus rings survive
  (`outline` won't be stripped, but verify offset/visibility), and give
  icon-only controls a forced-colors-visible border. Optionally a
  `prefers-contrast: more` pass to strengthen `--outline` tokens.

### 4. Audio player — the highest-value manual audit  ·  Medium/High impact
The two `<audio>` elements and the shared bar are the heart of the app and the
riskiest a11y surface. Needs a dedicated screen-reader pass, not just static ARIA:

- Does the play/pause button's `aria-label` update between "Play"/"Pause"/
  "Loading" states in a way SR users hear? (labels are set in `app.js:619`,
  `:309` — verify they re-announce.)
- Is playback progress perceivable non-visually? A `<input type=range>` scrubber
  exists in both the page bar and show-modal dock; confirm its value is announced
  as usable time rather than an unexplained raw second count. The current UI
  supplies a track/date-specific label but does not set `aria-valuetext`.
- Media Session metadata is wired (`clearMediaSession`, `app.js:778`) — good for
  lock-screen/AT integration; confirm title/artwork populate.
- Keyboard: Space = play/pause, ←/→ = ±15s are documented in `title=`
  (`index.html:273–282`); verify they work when focus is in the bar and don't
  hijack typing in the search field.

### 5. Touch-target sizing (WCAG 2.2 — 2.5.8)  ·  Low/Medium
2.2 AA wants interactive targets ≥ 24×24 CSS px (with spacing exceptions). Icon
buttons (close ✕, social, view-toggle, ±15s) should be audited; several are 36px
(fine), but confirm the small ones (`.more-link`, caret, dismiss ✕).

### 6. Motion / `prefers-reduced-motion` completeness  ·  Low
Already strong (13 blocks). Sweep for any remaining unconditional `transition`/
`animation` — the EQ bars on the On-Air button (`index.html:40`) and any toast
slide-ins — and confirm they're gated or purely decorative + `aria-hidden`.

### 7. Language & abbreviations  ·  Low
`lang="en"` is set. If any UI text mixes languages or uses opaque abbreviations,
add `lang`/`<abbr>` as needed. Likely already fine.

---

## Testing

Runtime stays dependency-free; testing is where packages earn their place
(dev/CI only, never shipped):

- **axe-core** (via `@axe-core/cli` or the browser extension) — automated WCAG
  checks. Catches missing labels, contrast, ARIA misuse. ~30–40% of issues are
  auto-detectable; the rest need humans.
- **Lighthouse** (built into Chrome DevTools) — quick a11y score + specific
  flags. Good for a baseline number to track.
- **WAVE** (browser extension) — visual overlay of the a11y tree; fast sanity check.
- **Manual keyboard pass** — unplug the mouse. Tab through everything; every
  control reachable, visible focus ring, logical order, no traps except intended
  modal traps, `Escape` always escapes.
- **Screen readers** — the real test:
  - macOS **VoiceOver** (Cmd+F5) + Safari
  - Windows **NVGT/NVDA** (free) + Firefox/Chrome
  - iOS **VoiceOver** + Android **TalkBack** for the mobile player
- **Zoom / reflow** — 200% browser zoom and 400% (WCAG 1.4.10 reflow); confirm
  no horizontal scroll (there's already iOS-Safari overflow work in git history).

Suggested cadence: axe + Lighthouse in a pre-commit or CI step for regressions;
a manual SR pass before any release that touches the player or a modal.

Two of the repo's own suites already cover a11y ground none of the above reaches,
because both assert *effects* rather than markup: `test/touch/` §3 measures real
tap targets against the 44px floor (2.5.8) and §4 proves the overlay scroll locks
actually hold, and `test/to-top/` proves a hidden control is genuinely
unreachable — out of the tab order and out of the hit test — rather than merely
transparent, and that a scroll-to-top moves keyboard focus along with the
viewport. See `docs/DEVELOPMENT.md` → *Back to top*.

---

## Proposed sequencing

1. **Quick wins:** result-count live region (#2), inert background (#1).
   Small diffs, big screen-reader payoff.
2. **Audit pass:** run axe + Lighthouse, record a baseline; do one full VoiceOver
   walkthrough of listing → sheet → live player → archive playback (#4).
3. **Robustness:** forced-colors / high-contrast (#3), touch targets (#5).
4. **Polish:** motion sweep (#6), language details (#7).
5. Decide, once #1 lands, whether native `<dialog>` is worth adopting or the
   custom overlays stay.

## Open questions

- Do we want a written **VPAT / conformance statement**, or just "we take a11y
  seriously and here's the checklist"? (Affects how formal the audit must be.)
- Native `<dialog>` migration: worth it, or does it risk the live-player audio
  behavior that `CLAUDE.md` warns is fragile? Lean toward *don't touch working
  audio* unless the win is clear.
- Any commitment to a specific WCAG **level** publicly? AA is the sane default;
  AAA is rarely fully achievable for a media app.

## References

- WCAG 2.2 quick ref: https://www.w3.org/WAI/WCAG22/quickref/
- ARIA Authoring Practices (dialog, listbox patterns): https://www.w3.org/WAI/ARIA/apg/
- MDN `inert`: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert
- MDN `<dialog>`: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog
- Forced colors: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors
