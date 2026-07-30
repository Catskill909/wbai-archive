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

`npm run dev` defaults to `http://localhost:8080`. Nothing else to configure.

## Step 3 — Build a macOS release

```bash
cd desktop
WBAI_APP_URL=https://your-domain npm run build
```

Output lands in `src-tauri/target/release/bundle/` (`dmg/` and `macos/`).

**`WBAI_APP_URL` is baked in at compile time** — `main.rs` reads it via
`option_env!`. Omit it and the app ships pointing at `localhost:8080`, which is
only useful for testing. There is deliberately no runtime setting for it: an app
that can be repointed after the fact is an app that can be repointed at
something you don't control.

macOS builds are not in CI because they need signing with your own certificates.
Unsigned builds run locally, but Gatekeeper will warn anyone else who opens one —
Step 6 is what to do about that.

## Step 4 — Set up Windows CI (once)

The Windows build runs in GitHub Actions:
`.github/workflows/desktop-windows.yml`.

1. Go to **Settings → Secrets and variables → Actions → Variables**.
2. Add a repository variable **`WBAI_APP_URL`** = your deployed URL.

Without it the workflow **fails on purpose** rather than silently producing an
app that points at localhost.

## Step 5 — Produce a Windows build

Either:

- **Push a tag** — `git tag v1.0.0 && git push origin v1.0.0`, or
- **Run it manually** — Actions → *Desktop (Windows)* → *Run workflow*, giving a
  URL in the input box (this overrides the repository variable).

Download the NSIS `.exe` from the run's artifacts. The workflow builds with
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

**On Apple's side, in order:**

1. **Enroll in the Apple Developer Program** — $99/year. Enroll as an
   **individual**, under your own name. Organization enrollment needs a D-U-N-S
   number and would have you claiming to represent WBAI/Pacifica; this client is
   unofficial, which is the same reason `identifier` avoids `org.wbai`.
2. **Create a "Developer ID Application" certificate.** Easiest: Xcode →
   Settings → Accounts → Manage Certificates → **+** → Developer ID Application.
   (Manual route: a CSR from Keychain Access, uploaded under Certificates,
   Identifiers & Profiles.) Requires the Account Holder role, and these are
   capped at 5 per account — don't spend them experimenting.
3. **Note your signing identity and Team ID.**
   `security find-identity -v -p codesigning` prints
   `Developer ID Application: Your Name (TEAMID)`.
4. **Create a notarization credential** — either an app-specific password
   (appleid.apple.com → Sign-In and Security), or an App Store Connect API key
   (Users and Access → Integrations), whose `.p8` downloads exactly once.

**Then build.** These env var names were read out of the Tauri CLI binary in
`desktop/node_modules`, so they match the version this repo pins:

```bash
cd desktop
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific password
export APPLE_TEAM_ID="TEAMID"
WBAI_APP_URL=https://your-domain npm run build
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

- **`identifier`** is `io.github.catskill909.wbaiarchive`, deliberately not under
  `org.wbai` — this is an unofficial client and shouldn't claim the station's
  namespace.
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
