# Desktop app (Tauri) — required steps

Native macOS and Windows builds of the web app, from `desktop/`.

> **Status: scaffolding only.** Project, config, icons and Windows CI are
> committed, and the Tauri CLI parses the config cleanly — but **no binary has
> been produced yet**, because building needs a Rust toolchain that wasn't
> installed when this was written. Treat every step below as untested until one
> build succeeds.

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
Unsigned builds run locally, but Gatekeeper will warn anyone else who opens one.

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

Download the NSIS `.exe` (and the `.msi`, if produced) from the run's artifacts.

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
- **Icons** came from `public/assets/app_icon_1024.png` via `sips`, `iconutil`
  (`.icns`) and a small Node script (`.ico` — six PNG-encoded sizes, 16→256).
  Regenerate them together if the mark ever changes.

## This is the project's only build step

`public/` and `server.js` stay zero-dependency and zero-toolchain — see
[DEVELOPMENT.md](DEVELOPMENT.md). Every bit of Rust and npm tooling lives under
`desktop/`, which is entirely optional: the web app builds, runs and deploys
without it, and `desktop/node_modules` and `src-tauri/target` are gitignored.
