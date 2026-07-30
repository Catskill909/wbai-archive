# Desktop app (Tauri) — required steps

Native macOS and Windows builds of the web app, from `desktop/`.

> **Status: nothing has been compiled yet.** Project, config, station profiles,
> icons, installer artwork and Windows CI are all committed, and the Tauri CLI
> parses the config cleanly — but **no binary has been produced**, because
> building needs a Rust toolchain that still isn't installed. Treat every step
> below as untested until one build succeeds.
>
> What *is* independently verified: **the Tauri CLI accepts the merged config**
> (`tauri build --config src-tauri/stations/wbai.json` now fails only on the
> missing cargo, and a deliberately bogus key was confirmed to fail *earlier* than
> that, so validation really is happening); the icons are 32-bit RGBA with the
> required `.ico` layers; the NSIS bitmaps are 24-bit BMPs, checked with a second
> parser; every asset path in the merged config resolves to a file on disk; and
> the artwork generator refuses to emit a blank sheet. What is not: that NSIS,
> Finder and `codesign` accept any of it. That is what the first build is for.

## What it is

A native window pointing at a **running instance of the web app**. Not a second
implementation — there is no Rust port of the scrapers, and there won't be.

That is forced by the same constraint the server exists for: the upstream feeds
send no `Access-Control-Allow-Origin` header, and a Tauri webview enforces CORS
exactly as a browser does. Listings, artwork and on-air data must keep coming
through the Node proxies. So a server is always involved — your deployment for a
release build, `npm start` for development.

What that buys: a real Dock/taskbar icon, a window that isn't a browser tab, and
OS media-key integration through the Media Session code the web app already has.

---

## Step 1 — Install prerequisites (once)

| Need | macOS | Windows |
| --- | --- | --- |
| Rust | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | [rustup-init.exe](https://rustup.rs) |
| System deps | `xcode-select --install` | "Desktop development with C++" in the Visual Studio Build Tools |
| Node | 18+ (already required by the server) | same |

Verify with `cd desktop && npx tauri info` — it must report a rustc and cargo
version. Everything else is already in the repo.

## Step 2 — Run it locally

Two terminals. The server has to be up first; the app is only a window onto it.

```bash
# terminal 1 — from the repo root
npm start                    # http://localhost:8080

# terminal 2
cd desktop
npm install                  # first time only
npm run dev
```

`npm run dev` defaults to `http://localhost:8080`. Nothing else to configure —
the window will say UNCONFIGURED, which is correct for a dev run with no station
selected. To develop against a real station's identity, pass its profile the same
way a release build does:

```bash
STATION_NAME="WBAI 99.5 FM Archive" npm run dev -- --config src-tauri/stations/wbai.json
```

## Step 3 — Build a macOS release

**One station per build.** The station's identity comes from a profile in
`src-tauri/stations/` and its URL from the environment:

```bash
cd desktop
STATION=wbai
STATION_URL=$(node -p "require('./stations.json')['$STATION'].url") \
STATION_NAME=$(node -p "require('./src-tauri/stations/$STATION.json').productName") \
  npm run build -- --config src-tauri/stations/$STATION.json
```

Reading both values from the files means a local build and a CI build point at
the same place; typing the URL by hand is how they drift.

Output lands in `src-tauri/target/release/bundle/` (`dmg/` and `macos/`).

**`--config` is not optional for a real build.** The base `tauri.conf.json` is
station-neutral and says `UNCONFIGURED` on purpose, so a forgotten profile is
loud rather than shipping one station's app under another's identifier. See
[`desktop/src-tauri/stations/README.md`](../desktop/src-tauri/stations/README.md)
for what a profile holds and how to add one.

**`STATION_URL` and `STATION_NAME` are baked in at compile time** — `main.rs`
reads both via `option_env!`. Omit the URL and the app ships pointing at
`localhost:8080`, which is only useful for testing. There is deliberately no
runtime setting for it: an app that can be repointed after the fact is an app
that can be repointed at something you don't control.

macOS builds are not in CI because they need signing with your own certificates.
Unsigned builds run locally, but Gatekeeper will warn anyone else who opens one —
Step 6 is what to do about that.

## Step 4 — Set up Windows CI (once)

The Windows build runs in GitHub Actions:
`.github/workflows/desktop-windows.yml`.

**There is nothing to configure.** No repository variables, no secrets. Each
station's deployment lives in [`desktop/stations.json`](../desktop/stations.json),
in git:

```json
{ "wbai": { "url": "https://wbai.supersoul.top" } }
```

That is a deliberate choice over an Actions variable: one variable cannot serve
several stations, and when a host changes, a commit records when and why. The URL
is compiled into the binary either way, so a change means a rebuild — there is no
setting to flip.

The workflow **fails on purpose** rather than guessing: no profile for the named
station (listing the ones that exist), or no URL for it, and the run stops.

Which station a **tag push** builds is a one-word default in the workflow
(`wbai`). **Manual runs** take the station from an input box, and can override
the URL from a second one for a throwaway build against staging.

## Step 5 — Produce a Windows build

Either:

- **Push a tag** — `git tag v1.0.0 && git push origin v1.0.0`, which builds the
  default station, or
- **Run it manually** — Actions → *Desktop (Windows)* → *Run workflow*, giving a
  station slug. This is the per-station path. The URL box is optional and only
  overrides `stations.json` for that one run.

Download the NSIS `.exe` from the run's artifacts — named
`station-archive-windows-<slug>`, so builds for different stations don't collide. The workflow builds with
`--bundles nsis`, overriding `bundle.targets` — that key also names `dmg` and
`app`, which only exist on macOS, and there's no reason for a Windows run to
depend on how the bundler treats them.

The run also uploads a **`cargo-lock`** artifact. No `Cargo.lock` is committed,
so each run re-resolves Tauri 2.x and an upstream release can break a build with
no change on our side. Grab that file from the first green run and commit it to
`desktop/src-tauri/` — the build becomes reproducible and `rust-cache` gets a
real key.

---

## Step 6 — macOS signing and notarization

Everything above works unsigned. This step is only about handing a `.dmg` to
someone else without macOS refusing to open it.

Skip it and you get a bundle that runs on your own machine (right-click → Open
the first time). Anyone else has to go to System Settings → Privacy & Security →
Open Anyway, which is not a thing you can ask a listener to do.

**Sign as the station, not as yourself.** A certificate attests to a legal
identity, so the account that signs a station's app has to be that station's.

- **Pacifica Foundation is one legal entity** holding the licenses for WBAI,
  KPFA, KPFK, WPFW and KPFT. One Pacifica developer account and one Developer ID
  Application certificate covers all five; only the bundle identifier differs.
- **Affiliates are separate entities** and each needs its own account and
  certificate. Signing an affiliate's app with Pacifica's certificate would name
  Pacifica as the developer of software that isn't theirs.
- **Your personal account is for test builds only.** It puts your legal name on
  the app as the verified developer, and a Developer ID certificate cannot be
  transferred to the client later — they'd have to re-sign, under a new identity.

**On Apple's side, in order:**

1. **Use the station's organization account.** Pacifica already has one, with
   their existing apps in it. An affiliate starting from nothing has to enroll
   themselves — organization enrollment needs a D-U-N-S number and someone with
   authority to bind the entity, so it is never the contractor's to do.
2. **Look for a certificate they already have, before anyone creates one.** An
   organization that has been shipping apps for years usually has a Developer ID
   Application certificate already, and they are **capped at 5 per account** —
   spending one by reflex is a bad trade. Certificates, Identifiers & Profiles →
   Certificates, filter **Developer ID Application**: an Admin can read that list
   even though they can't add to it. Note the expiry (these run 5 years).

   If one exists, the work isn't issuing a certificate — it's **finding the Mac
   that holds its private key**, because Apple keeps only the public half. Whoever
   generated it exports the pair as a `.p12` (Keychain Access → right-click the
   certificate → Export) and hands it over.

   Beware the near-miss: a **"Distribution Managed"** certificate is an *Apple
   Distribution* cert for the App Store, cloud-managed, with the private key held
   by Apple. It cannot sign a `.dmg` and cannot be exported. An account can be
   full of certificates and still have nothing that works here.

3. **If there's genuinely no usable certificate, only the Account Holder can make
   one — Admin is not enough.** Apple's documented path for an Admin is
   *cloud-managed* certificates, which **do not help here**: cloud signing only
   works through the Xcode Organizer archive-and-distribute workflow, and Tauri's
   bundler shells out to `codesign` against a local keychain identity instead.

   **Use the CSR route, not the Xcode route.** The private key is created by
   whoever generates the *signing request*, not by whoever creates the
   certificate. So the developer generates it, and the Account Holder — who is
   often an executive with no developer tools and no reason to acquire any — only
   uploads a file and downloads another, in a browser:

   1. **You:** Keychain Access → Certificate Assistant → **Request a Certificate
      From a Certificate Authority**. Enter the client's contact email, leave CA
      Email blank, choose **Saved to disk**, key size 2048, algorithm RSA. This
      writes `CertificateSigningRequest.certSigningRequest` and puts a fresh
      private key in *your* login keychain.
   2. **Account Holder:** developer.apple.com → Certificates, Identifiers &
      Profiles → Certificates → **+** → **Developer ID Application** → upload the
      `.certSigningRequest` → Continue → **Download** the `.cer` → send it back.
      No Xcode, no Keychain Access, no password to share, roughly three minutes.
   3. **You:** double-click the `.cer`. It pairs with the private key already in
      your keychain, and `security find-identity -v -p codesigning` starts listing
      the identity.

   This beats a `.p12` handoff on every axis: nothing secret crosses the wire, no
   shared password, and no one has to walk a non-technical executive through
   exporting key material. The Xcode route is only simpler when the Account Holder
   is *already* a developer on a Mac with Xcode installed.

   **Never ask for their Apple ID credentials** as a shortcut. Account sharing
   breaks Apple's agreement, and the whole point of the CSR flow is that it
   doesn't need it.

   **Then close the loop on custody.** The CSR route leaves the only copy of the
   private key on the developer's machine, which is convenient now and a liability
   later. Export a `.p12` backup and give it to the client for their records, so
   the certificate outlives the engagement — and note that revoking it in the
   portal is how they cut off a departing contractor.

   While you're in the portal as Admin, check **Identifiers** too — an account
   with existing station apps has a bundle-ID convention, and the desktop app
   should follow it rather than collide with it. That's what decides whether the
   profile says `org.wbai.archive` or something in their existing namespace.

   **Not an App ID.** Registering an identifier under *Identifiers* does nothing
   for this. App IDs exist to bind a bundle ID to provisioning profiles and
   capabilities (push, iCloud, App Groups) — that's App Store, TestFlight and
   Mac App Store territory. Direct distribution is signed with a certificate and
   cleared by notarization; Apple's own instructions for a Developer ID
   certificate never mention registering an identifier first. A station's
   `org.wbai.archive` only has to be *well-formed*, not registered. Creating an
   App ID anyway is harmless and inert.

   Skip **Developer ID Installer** too — that signs `.pkg` files, and we ship a
   `.dmg`.

   **The private key is the half nobody can reissue.** Apple can replace a
   certificate; it cannot replace the key, because it never had it. So the `.p12`
   plus its password is the only thing that survives a wiped laptop — and base64
   of that same file is `APPLE_CERTIFICATE` if macOS ever moves into CI.
4. **Note the signing identity and Team ID.**
   `security find-identity -v -p codesigning` prints
   `Developer ID Application: Pacifica Foundation (TEAMID)` once the `.cer` is
   installed — which doubles as proof the certificate found its private key. If it
   still reports `0 valid identities found`, the certificate is there and the key
   isn't; nothing will sign until that's resolved.
5. **Create a notarization credential.** This part *doesn't* need their Account
   Holder: notarytool authorizes on team membership, so your own Apple ID plus an
   app-specific password (appleid.apple.com → Sign-In and Security) plus **their**
   Team ID is enough. An App Store Connect API key (Users and Access →
   Integrations) works too, and its `.p8` downloads exactly once.

**Then build.** These env var names were read out of the Tauri CLI binary in
`desktop/node_modules`, so they match the version this repo pins:

```bash
cd desktop
export APPLE_SIGNING_IDENTITY="Developer ID Application: Pacifica Foundation (TEAMID)"
export APPLE_ID="you@example.com"            # your Apple ID, as a team member
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"  # your app-specific password
export APPLE_TEAM_ID="TEAMID"                # theirs
STATION_URL=https://archive.wbai.org STATION_NAME="WBAI 99.5 FM Archive" \
  npm run build -- --config src-tauri/stations/wbai.json
```

The API-key alternative is `APPLE_API_KEY`, `APPLE_API_ISSUER` and
`APPLE_API_KEY_PATH`. For a future macOS CI job, the certificate goes in as
`APPLE_CERTIFICATE` (base64 `.p12`) plus `APPLE_CERTIFICATE_PASSWORD`.

Hardened runtime is on by default and notarization requires it. The app is
unsandboxed and only loads plain HTTPS, so no entitlements file is needed.

**Verify against Gatekeeper, not against the build log** — §1 of `CLAUDE.md`
applies here too; a bundle that compiled proves nothing about what another Mac
does with it:

```bash
spctl -a -vvv -t install "src-tauri/target/release/bundle/macos/WBAI Archive.app"
xcrun stapler validate src-tauri/target/release/bundle/dmg/*.dmg
```

**Rehearse the chain on a personal paid account while waiting for theirs.** The
whole sign → notarize → staple → `spctl` sequence works identically under any
paid Developer Program membership, so it can be exercised end to end before the
station's certificate exists: your identity, your Apple ID, your team ID. When
theirs arrives you are changing three environment variables instead of debugging
Gatekeeper for the first time under a deadline. Two rules — don't distribute a
personally-signed build of someone else's station, and delete it afterwards.

**One thing Apple won't tell you:** `npm run build` targets your host
architecture only, so an Apple-silicon build won't run on an Intel Mac. For both:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build -- --target universal-apple-darwin
```

---

## Step 7 — Installer artwork (built)

Both installers have real artwork now, generated per station. What is *not* yet
proven is that NSIS and Finder accept it — that needs a build, and no build has
run. Everything below describes committed files and verified formats.

Regenerate any time:

```bash
cd desktop
npm run artwork wbai        # -> src-tauri/installer/wbai/
```

### The palette comes from the app icon

No new brand work. `public/assets/app_icon_1024.png` is a four-quadrant
`W B A I` mark, and those colours plus the app's own surface token are the entire
installer palette. They live in one `PALETTE` object in `installer/render.js`:

| Role | Hex | Where it comes from |
| --- | --- | --- |
| Ink / glyphs | `#fafafa` | the letters in the mark |
| Ink dim / faint | `#b7a99e` / `#7d7168` | `--ink-dim`, `--ink-faint` |
| Accent blue | `#2f8ab9` | `I` quadrant — the one saturated colour, used only for the arrow and two hairlines |
| Canvas | `#14100f` | `--surface-0` in `public/styles.css` (dark) |
| Deep maroon / warm grey / light grey | `#362224` / `#595353` / `#989994` | the other three quadrants, present via the mark itself |

On-air red (`--accent`, `#e14a2e`) is deliberately **absent**: it means "live" in
the app, and an installer is not live.

Type is the app's `--font-display`, Arial Narrow — confirmed actually resolving,
not silently falling back: it measures 105px where Helvetica Neue measures 128px
for the same string. `font-stretch: condensed` was removed as a no-op; the family
is already narrow, and specifying both is how you get a silent fallback later.

### How it is generated

`desktop/installer/` holds three HTML templates and `render.js`. Chrome renders
each at exact pixel dimensions; the two NSIS sheets are then converted to
**24-bit BI_RGB BMP** by an encoder in the same file, because NSIS has no alpha
channel and will not take a PNG.

HTML rather than SVG or a design file, for one reason: the artwork is per station
and there will eventually be several, so it has to be diffable text that a
command regenerates identically. Chrome rather than a library, because it is
already installed on any machine doing this work — and the whole tree stays out
of the web app, which remains zero-toolchain.

**Two traps, both already stepped in:**

- **A blank render produces a perfectly valid file.** A 24-bit BMP's size is
  fixed by its dimensions, so a template that paints nothing yields a normal
  looking, entirely empty bitmap that Tauri bundles without complaint. `render.js`
  therefore measures **ink coverage** — the fraction of pixels differing from the
  canvas colour — and refuses to write a sheet below a floor (currently 20.9%,
  19.7% and 23.2% against floors of 6%, 4% and 1%). This is `CLAUDE.md` §3a
  applied to artwork: assert the effect, not the declaration. The check has been
  verified to fire, by reintroducing the bug and watching it fail.
- **Centered absolute elements need an explicit pixel width.** In headless
  Chrome, an element that is `position:absolute` against the page, takes its
  width from `left:0;right:0` or `width:100%`, *and* centres its contents
  (`text-align:center`, or `align-items:center` on a flex row) paints **nothing
  at all** — text and images both vanish, backgrounds still draw. Give it
  `width: 164px` and it renders. The sidebar was silently blank until this was
  bisected; the DMG template avoids it by putting everything inside a fixed-width
  stage.

### macOS — the DMG window

Mechanics in the base config, art path in the station profile:

```jsonc
// tauri.conf.json — station-neutral
"macOS": { "dmg": {
  "windowSize": { "width": 660, "height": 400 },
  "appPosition": { "x": 180, "y": 170 },
  "applicationFolderPosition": { "x": 480, "y": 170 }
}}

// stations/wbai.json
"macOS": { "dmg": { "background": "installer/wbai/dmg-background.png" } }
```

- **The background art and those coordinates are one design.** The dashed arrow
  is positioned in the gap between the two icon wells — 180 + 64 through
  480 − 64 — so if the positions move in `tauri.conf.json`, the template's
  `.arrow` has to move with them. The template says so, in a comment, at the top.
- **Designed in points, emitted at 2×.** The template lays out in a 660 × 400
  stage and renders through `transform: scale(2)` to 1320 × 800 for retina. Tauri
  accepts `png`/`jpg`/`gif` only — the multi-resolution TIFF trick isn't
  available. If Finder renders it soft, fall back to a 1× 660 × 400 sheet.
- **One image serves both system themes.** Finder doesn't theme a DMG
  background, so the art carries its own dark canvas.
- **The bottom band is empty on purpose** — Finder can draw a status strip there.
- Finder draws the two icons *and their labels*; the art never duplicates them.

### Windows — the NSIS wizard

| Key | Asset | Size | State |
| --- | --- | --- | --- |
| `headerImage` | strip on the middle pages | **150 × 57** | ✅ 24-bit BMP |
| `sidebarImage` | Welcome and Finish pages | **164 × 314** | ✅ 24-bit BMP |
| `installerIcon` / `uninstallerIcon` | wizard and uninstaller icon | `.ico` | ✅ reuses `icons/icon.ico` |

Both BMPs report as `PC bitmap, Windows 3.x format, … x 24` — checked with a
second, independent parser (`sips`) rather than trusting the encoder that wrote
them.

- **150 × 57 is tiny**, so it gets the mark at 34px, the product name at 14px
  with ellipsis, and a 7.5px label. Nothing else fits legibly.
- **164 × 314 is a tall panel**: mark at 88px, name, `DESKTOP PLAYER`, then a
  rule and the copyright line at the bottom. The middle-lower area stays empty
  because NSIS draws its own body text over this bitmap on the Welcome page.
- **`installMode: "currentUser"`** is set in the base config — a per-user install
  raises no UAC prompt, and the app writes nothing outside its own directory.
- `languages: ["English"]` is explicit; `startMenuFolder` stays unset, since one
  app needs no group.
- `uninstallerHeaderImage` is left unset: it defaults to `headerImage`.

If the `.msi` target is ever added, WiX needs its own pair — `bannerPath`
(493 × 58) and `dialogImagePath` (493 × 312), also BMP.

### What's committed

```
desktop/installer/
  render.js                     # generator: Chrome -> PNG -> 24-bit BMP, + ink guard
  src/nsis-header.html          # sources, per-sheet, with the layout notes
  src/nsis-sidebar.html
  src/dmg-background.html
desktop/src-tauri/installer/wbai/
  nsis-header.bmp               # 150x57   24-bit
  nsis-sidebar.bmp              # 164x314  24-bit
  dmg-background.png            # 1320x800
```

Rendered assets are committed so CI needs no design toolchain; the templates are
committed beside them so the assets are reproducible. Config paths resolve
relative to `src-tauri/`.

### Still unverified — needs the first build

Formats are proven; acceptance is not. §1 of `CLAUDE.md` applies as much to
installers as to `app.js` — a bitmap the bundler silently skipped looks exactly
like one that was never made.

1. `open src-tauri/target/release/bundle/dmg/*.dmg` — does the mounted window
   match the art, at 1× and on a retina display, with the icons landing on the
   arrow?
2. Run the NSIS `.exe` in a Windows VM and step every page — Welcome, the middle
   pages that use `headerImage`, Finish, then the uninstaller.
3. Check both at 100% and 200% display scaling; the header strip is where
   scaling artefacts show first.

### Not done yet

- **The app icon has no transparency.** Its rounded corners are painted
  `#1a1a1a`, so macOS will draw a hard square instead of applying its squircle.
  Fixing it means masking the corners and adding the ~10% margin macOS expects,
  then re-running `npx tauri icon`.
- **A second station's artwork is one command**, but it will use the same WBAI
  mark until that station ships its own icon set — see
  `src-tauri/stations/README.md`.

---

## Step 8 — Windows signing (optional, and nothing is signed today)

**Every Windows build this repo has ever produced is unsigned.** That is not an
oversight to be embarrassed about, it's the default: there is no
`bundle.windows.certificateThumbprint`, no `signCommand`, and no signing step in
the workflow. GitHub Actions does not sign artifacts, and no account is
implicitly involved. The consequence is a SmartScreen "unknown publisher" warning
that the user can click past.

Unlike macOS, Windows has **no Account Holder problem, no notary service and no
role permissions**. An unsigned installer runs. This step is entirely optional
and can be deferred indefinitely.

When it does matter — when the publisher name should read *Pacifica Foundation*
rather than *Unknown* — two things are worth knowing before anyone budgets it:

- **The certificate comes from a commercial CA** (DigiCert, Sectigo, SSL.com),
  not Microsoft. Roughly $200–400/year, and an OV certificate requires *business*
  validation, so the station has to buy it and pass the validation. That's the
  organizational dependency: paperwork and payment, not a portal role.
- **Since 2023, code-signing private keys must live on FIPS-certified hardware** —
  a USB token or a cloud HSM. "Put the `.pfx` in a GitHub secret" is no longer a
  thing that exists. CI signing means a cloud signing service, which is a
  different integration than the `certificateThumbprint` field suggests.

SmartScreen reputation also accrues per certificate: a brand-new OV certificate
can still warn until enough installs accumulate.

---

## Notes for whoever builds it first

- **`identifier` lives in the station profile, not here.** The base config's
  `org.example.stationarchive` is a placeholder that exists to be conspicuous;
  `stations/wbai.json` sets `org.wbai.archive`. It moved out of the base config
  when this became a per-station build — and it was `io.github.catskill909.*`
  before that, when the app was an unofficial client with no station behind it.
  **Check the station's existing Identifiers before adding a profile**, so a new
  app doesn't collide with or contradict the convention their other apps use.
- **The crate is still named `wbai-archive`.** `Cargo.toml` and
  `desktop/package.json` carry WBAI-specific names and descriptions even though
  everything user-facing is now per station. Renaming them changes the built
  binary's filename, and adding an untested variable *before the first successful
  compile* is a bad trade — do it once a build is known good.
- **`frontendDist` points at `../../public`** even though the window loads a
  remote URL and never reads those files. It keeps the config valid and leaves
  the door open to a bundled-assets variant. Harmless, ~1 MB.
- **`app.windows` is empty on purpose.** The window is built in `setup()` so its
  URL can come from an environment variable; a window declared in
  `tauri.conf.json` would be created *as well*, giving you two.
- **`csp` is `null`.** The page comes from our own server, which already sends a
  Content-Security-Policy header. A second one here would be two copies to keep
  in sync.
- **Icons are generated, never hand-rolled.** One command, from `desktop/`:

  ```bash
  npx tauri icon ../public/assets/app_icon_1024.png
  ```

  It writes `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.ico`
  and `icon.icns` in one pass. It also emits `Square*Logo.png`, `StoreLogo.png`,
  `64x64.png` and mobile sets — we don't commit those, because nothing we build
  (NSIS, DMG) reads them.

  **They must be 32-bit RGBA.** Tauri's requirement is "width == height, RGBA
  (RGB + Transparency), and 32bit per pixel." The first committed set was
  24-bit RGB with no alpha channel — including six PNG-encoded `.ico` layers
  whose directory entries claimed `bpp=32` — which would have failed a build
  nobody had run yet. Use the command above and this can't recur; if you ever
  touch these by hand, check `colorType == 6` before committing.

  Two things about the source art, neither of them blocking:
  - `app_icon_1024.png` is **890 × 890**, despite the name. Every desktop size
    is a downscale from a non-power-of-two source.
  - Its rounded corners are **painted `#1a1a1a`, not transparent**, so the alpha
    channel is uniformly opaque. macOS will render the Dock icon as a hard
    square instead of applying its own squircle. Fixing that means masking the
    corners to real transparency and adding the ~10% margin macOS expects —
    art work, tracked with the installer artwork in Step 7, not a build issue.

## This is the project's only build step

`public/` and `server.js` stay zero-dependency and zero-toolchain — see
[DEVELOPMENT.md](DEVELOPMENT.md). Every bit of Rust and npm tooling lives under
`desktop/`, which is entirely optional: the web app builds, runs and deploys
without it, and `desktop/node_modules` and `src-tauri/target` are gitignored.
