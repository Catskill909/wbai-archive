# Desktop app (Tauri) — required steps

Native macOS and Windows builds of the web app, from `desktop/`.

> **Status: scaffolding only.** Project, config, icons and Windows CI are
> committed, and the Tauri CLI parses the config cleanly — but **no binary has
> been produced yet**, because building needs a Rust toolchain that wasn't
> installed when this was written. Treat every step below as untested until one
> build succeeds. Installer artwork is planned but not made — both installers
> currently ship with stock DMG and NSIS chrome (see Step 7).

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
STATION_NAME="WBAI 99.5 FM Archive" npm run dev -- --config stations/wbai.json
```

## Step 3 — Build a macOS release

**One station per build.** The station's identity comes from a profile in
`src-tauri/stations/` and its URL from the environment:

```bash
cd desktop
STATION_URL=https://archive.wbai.org STATION_NAME="WBAI 99.5 FM Archive" \
  npm run build -- --config stations/wbai.json
```

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

1. Go to **Settings → Secrets and variables → Actions → Variables**.
2. Add a repository variable **`STATION_URL`** = that station's deployed URL.
3. Optionally add **`STATION`** = the default profile slug (defaults to `wbai`).

Without a URL the workflow **fails on purpose** rather than silently producing an
app that points at localhost, and it fails just as deliberately if the named
station has no profile — listing the ones that do.

Both are overridable per run from the workflow's input boxes, which is how you
build a second station without touching repository settings.

## Step 5 — Produce a Windows build

Either:

- **Push a tag** — `git tag v1.0.0 && git push origin v1.0.0`, which builds the
  default station, or
- **Run it manually** — Actions → *Desktop (Windows)* → *Run workflow*, giving a
  station slug and a URL in the input boxes (these override the repository
  variables). This is the per-station path.

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
  npm run build -- --config stations/wbai.json
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

**One thing Apple won't tell you:** `npm run build` targets your host
architecture only, so an Apple-silicon build won't run on an Intel Mac. For both:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build -- --target universal-apple-darwin
```

---

## Step 7 — Installer look and feel (planned, not built)

Right now both installers ship stock: a bare DMG window with two icons on grey,
and an NSIS wizard with NSIS's own default header art. Nothing below has been
implemented — this is the plan.

### The palette comes from the app icon

No new brand work. `public/assets/app_icon_1024.png` is a four-quadrant
`W B A I` mark, and those four colours plus the app's own surface token are the
entire installer palette:

| Role | Hex | Where it comes from |
| --- | --- | --- |
| Ink / glyphs | `#fafafa` | the letters in the mark |
| Deep maroon | `#362224` | `W` quadrant |
| Warm grey | `#595353` | `B` quadrant |
| Light grey | `#989994` | `A` quadrant |
| Accent blue | `#2f8ab9` | `I` quadrant — the one saturated colour, use it sparingly |
| Canvas | `#14100f` | `--surface-0` in `public/styles.css` (dark) |
| On-air red | `#e14a2e` | `--accent` — **installer chrome only if nothing else needs emphasis**; it means "live" in the app |

Type follows the app too: `--font-display` is Arial Narrow / condensed, which is
what the wordmark should be set in. Body text on installer panels stays in the
platform UI font — Segoe UI on Windows, SF on macOS — because installers should
look native, not branded-over.

The look to aim for: dark canvas, generous margins, the icon large and
uncropped, one line of condensed display type, no gradients-over-photos, no
drop shadows on text. Modern here means restraint, not decoration.

### macOS — the DMG window

Tauri drives this from `bundle.macOS.dmg` (verified against
`config.schema.json` in the CLI):

```jsonc
"macOS": {
  "dmg": {
    "background": "installer/dmg-background.png",
    "windowSize": { "width": 660, "height": 400 },
    "appPosition": { "x": 180, "y": 170 },
    "applicationFolderPosition": { "x": 480, "y": 170 }
  }
}
```

- **The background art and those coordinates are one design.** The image is the
  layout: the drag-here arrow, the labels and the wordmark are painted into the
  background, and `appPosition` / `applicationFolderPosition` must land the two
  real icons exactly where the art expects them. Change one, re-check the other.
- **Window size is in points, art is in pixels.** Author the background at 2×
  (1320 × 800) for the retina case, and if Finder renders it soft or wrong-sized,
  fall back to a 1× 660 × 400 PNG. Tauri accepts `png`/`jpg`/`gif` only — the
  classic multi-resolution TIFF trick is not available through this config.
- **One image serves both system themes.** Finder does not theme a DMG
  background, so the art must carry its own dark canvas and not assume the
  window furniture around it is dark.
- **Keep the bottom ~64 points quiet.** Finder can draw a status strip there.

Planned layout: icon-and-wordmark block on the left third, then app icon → thin
arrow → Applications folder across the middle, `#2f8ab9` used only for the
arrow.

### Windows — the NSIS wizard

Config lives at `bundle.windows.nsis`:

| Key | Asset | Exact size |
| --- | --- | --- |
| `headerImage` | strip on every page but the first and last | **150 × 57** BMP |
| `sidebarImage` | Welcome and Finish pages | **164 × 314** BMP |
| `installerIcon` | wizard window / taskbar icon | `.ico` |
| `uninstallerIcon` | same, for uninstall | `.ico` |

- **These must be BMP, and BMP has no alpha.** Bake the canvas colour in; do not
  export a transparent PNG and rename it. Save as 24-bit BMP (BMP3) — NSIS is
  the pickiest consumer in this whole repo.
- **150 × 57 is tiny.** It gets the four-quadrant mark and nothing else; the
  wordmark is illegible at that height and should be left out.
- **164 × 314 is a tall thin panel.** Icon top-centre, product name under it in
  condensed type, everything below the top third left as empty canvas so the
  page's own text doesn't fight it.
- Also set **`installMode: "currentUser"`** — a per-user install needs no UAC
  prompt, and this app writes nothing outside its own directory. That is a
  first-run-experience decision as much as a packaging one.
- `startMenuFolder` stays unset: one app, no group.

If the `.msi` target is ever kept, WiX takes its own pair — `bannerPath`
(493 × 58) and `dialogImagePath` (493 × 312) — same art, different crops. Both
are also BMP.

### Where the files go

```
desktop/src-tauri/installer/
  dmg-background.png        # 1320x800
  nsis-header.bmp           # 150x57
  nsis-sidebar.bmp          # 164x314
  src/*.svg                 # the sources everything above is rendered from
```

Paths in `tauri.conf.json` are relative to that file, so `installer/...` as
written above. Commit the rendered assets — CI must not need a design toolchain
— but commit the SVG sources next to them, the way the icons' provenance is
already recorded in the notes below. A one-shot render script belongs in
`desktop/`, never at the repo root: `public/` and `server.js` stay
zero-toolchain.

### How we'll know it's right

Screenshots, not config diffs. §1 of `CLAUDE.md` applies to installers as much
as to `app.js` — a background image that the bundler silently skipped looks
exactly like one that isn't finished yet.

1. `open src-tauri/target/release/bundle/dmg/*.dmg` and confirm the mounted
   window matches the art, at both 1× and on a retina display.
2. Run the NSIS `.exe` in a Windows VM and step through every page — Welcome,
   the middle pages that use `headerImage`, Finish, then the uninstaller.
3. Check both at 100% and 200% display scaling; the header strip is where
   scaling artefacts show first.

---

## Notes for whoever builds it first

- **`identifier` lives in the station profile, not here.** The base config's
  `org.example.stationarchive` is a placeholder that exists to be conspicuous;
  `stations/wbai.json` sets `org.wbai.archive`. It moved out of the base config
  when this became a per-station build — and it was `io.github.catskill909.*`
  before that, when the app was an unofficial client with no station behind it.
  **Check the station's existing Identifiers before adding a profile**, so a new
  app doesn't collide with or contradict the convention their other apps use.
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
