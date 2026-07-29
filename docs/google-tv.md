# google-tv.md — what "Google TV compliant" would actually cost

Research date: **2026-07-29**. **Status: research only. Nothing built, nothing
committed to.** Same rules as [ROADMAP.md](ROADMAP.md).

The question that started it: *how would we make this app Google TV compliant?*
The short answer is that there is no path that reuses the web app, and the
realistic one is a second codebase. What was built instead was
[casting](casting-dev.md), which reaches the same TVs without any of this.

---

## 0. TL;DR

| | |
| --- | --- |
| What "compliant" means | Passing Google Play's **TV app quality guidelines** |
| Google TV vs Android TV | Same target. All Android TV apps run on Google TV; **no separate build** |
| Can we ship the PWA? | **No.** TWA does not work on TV — see §1 |
| Can we ship a WebView wrapper? | **Technically yes, practically no** — §1 |
| Realistic path | A **native Android TV app** (Kotlin, Compose for TV, Media3) |
| Does our backend survive? | **Yes** — `/api/*` is already the right shape |
| What must be rebuilt | The entire front end, for a 10-foot D-pad screen |

---

## 1. Why the cheap routes are closed

**Trusted Web Activity — dead on TV.** The obvious move, and the same instinct
[TAURI.md](TAURI.md) applies to desktop, is to wrap the PWA. TWA requires a
browser implementing the TWA protocol (Chrome 72+). **Android TV devices ship no
Chrome.** Developers hitting this report the launcher logging `Found no TWA
providers, using first browser: null` and a black screen. Bubblewrap's fallback
chain is Custom Tabs → default browser, and a TV has neither.

**A plain WebView wrapper — allowed, but it fails on two counts.** Quality
requirement **TV-WB** does permit web content in a `WebView`. But:

1. **TV-DP** requires *every* piece of functionality to be operable by five-way
   D-pad. Our listing is a ~500-row sortable table with a search field, a custom
   listbox and five overlays. In a WebView, D-pad presses arrive as arrow keys
   and Chromium's spatial navigation is off by default — most of that UI is
   simply unreachable.
2. **Play policy 4.3 (Minimum Functionality)** tightened in 2026: WebView apps
   that mirror a website without app-specific value are rejected. The sanctioned
   escape hatch Google names is TWA, which we cannot use.

So: a **native Android TV app**, or nothing.

---

## 2. What survives, and what doesn't

**The backend survives intact.** `server.js` already exposes a clean JSON API —
`/api/archive`, `/api/showinfo`, `/api/nowplaying`, `/api/programs`,
`/api/livestatus` — so a TV client is a *new front end, not a new system*. The
CORS constraint that forces the proxy doesn't bind a native HTTP client, but
we'd keep the proxy anyway for its caching and XML parsing.

**The front end does not survive at all.** Roughly the job `public/app.js` does
in ~2,900 lines, re-expressed for a 10-foot screen.

---

## 3. Requirement-by-requirement

**Nearly free — things this app already does:**

| Req | Why we're close |
| --- | --- |
| TV-NP / TV-PA | Audio continuing across app switches needs a Now Playing card. We already publish full Media Session metadata; same concept via Media3 `MediaSession`. |
| TV-PP / TV-PC | D-pad centre = play/pause, left/right = skip. We already bind Space and ←/→ to exactly this. |
| TV-BA | Audio-only apps must **not** block Ambient Mode. Relevant *because* we're audio: a video app suppresses it, we shouldn't. |
| TV-LO | Landscape only. Trivial. |

**Real work:**

| Req | Gap |
| --- | --- |
| **TV-DP** | Full D-pad navigation — a browse grid, not a table. The biggest single item. Our accessibility work (roving tabindex, focus traps, `:focus-visible`) is the right instinct but none of the code transfers. |
| **TV-OV** | Overscan-safe margins; nothing clipped at the edges. |
| **TV-DB** | Back must exit to the Google TV home screen. Ours currently closes the info sheet. |
| **TV-LB / TV-BN** | A 320×180 banner containing the app name, plus a ≥160×160 icon. New assets. |
| Search | No keyboard on a TV. D-pad-driven, ideally voice (**TV-VS**, tier 2). |
| Typography | `styles.css` is sized for phones and desks. |

**Play mechanics:** App Bundle mandatory (TV-G1); `minSdkVersion` ≤ 31 (TV-PS);
64-bit + 16 KB page sizes from **1 Aug 2026** (TV-G6); target API 33+ for TV by
**31 Aug 2026**. A new app on current tooling clears both by default.

**Google TV extras** (not required for compliance, but they're what "being on
Google TV" means to a user): **Watch Next** continue-watching tiles on the home
screen — a natural fit for our resume-position feature, but it requires quality
certification. The **Media Actions feed** that powers voice and search is
onboarded by invitation only; don't plan around it.

---

## 4. Assessment

Given this repo's stated values — zero dependencies, no build step, one
implementation — a native Android TV app is a genuine departure: a Kotlin/Gradle
project, a second UI to keep in sync, and Play Store release obligations
forever. Much larger than the Tauri scaffold, which is honest about being just a
window onto the server.

**Recommendation: not now.** [Casting](casting-dev.md) was built instead and
reaches the same TVs. Casting is also quality requirement **TV-CT** for a TV
app, so it is a prerequisite rather than a detour.

Reopen this if: casting proves insufficient on Android (see casting-dev.md §5),
*or* there's a reason to want a Play Store listing for its own sake — discovery
and legitimacy are real benefits this analysis doesn't price.

---

## Sources

- [TV app quality](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [Distribute to Android TV](https://developer.android.com/training/tv/publishing/distribute)
- [Google TV best practices](https://developer.android.com/training/tv/get-started/google-tv)
- [TV hardware features](https://developer.android.com/training/tv/start/hardware)
- [TWA overview](https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities)
- [TWA on Android TV — black screen](https://github.com/GoogleChromeLabs/svgomg-twa/issues/91)
- [64-bit for Google TV, Aug 2026](https://android-developers.googleblog.com/2025/08/64-bit-app-compatibility-for-google-tv-android-tv.html)
