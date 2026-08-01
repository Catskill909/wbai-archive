# Station profiles

One file per station. Each is a **partial** `tauri.conf.json`, merged over the
base by `tauri build --config src-tauri/stations/<slug>.json`, so it carries only what
differs between stations: the name, the bundle identifier, the store copy and
the copyright line.

```bash
STATION=wbai
STATION_URL=$(node -p "require('./stations.json')['$STATION'].url") \
STATION_NAME=$(node -p "require('./src-tauri/stations/$STATION.json').productName") \
  npm run build -- --config src-tauri/stations/$STATION.json
```

The URL comes from `desktop/stations.json`; the name comes from the profile. Both
are read rather than typed so that a local build and a CI build point at the same
deployment.

The base `tauri.conf.json` is deliberately **not** shippable on its own — its
identifier is `org.example.stationarchive` and its product name says
UNCONFIGURED. A build without `--config` is meant to look obviously wrong rather
than quietly ship one station's app under another's name.

## Adding a station

1. Copy `wbai.json`. Set `productName`, `identifier` and the three bundle
   strings.
2. **The identifier is the one thing you cannot change later.** Use reverse-DNS
   of a domain that station controls (`org.kpfa.archive`). Once a build is
   public, a new identifier makes macOS and Windows treat it as a different app:
   no in-place update, separate application data, a second entry in
   Add/Remove Programs.
3. For a different icon, add `"bundle": { "icon": [...] }` pointing at
   `stations/<slug>/icons/*`. Paths resolve relative to `src-tauri/`. Generate
   the set with `npx tauri icon` — see the icon notes in `docs/TAURI.md`; the
   files must be 32-bit RGBA.
4. **Render the installer artwork**, which is also per station:

   ```bash
   npm run artwork <slug>      # from desktop/
   ```

   It reads `productName` and `copyright` straight out of the profile, uses that
   station's icon if it ships one, and writes
   `src-tauri/installer/<slug>/`. Then point the profile's
   `bundle.windows.nsis.headerImage` / `sidebarImage` and
   `bundle.macOS.dmg.background` at those files, as `wbai.json` does.
5. **Add its URL to `desktop/stations.json`** — the deployment the window loads.

## Who can sign what

A code-signing certificate attests to a legal identity, so it does not travel
between stations.

- **WBAI, KPFA, KPFK, WPFW, KPFT** are all licensed to the **Pacifica
  Foundation** — a single legal entity. One Pacifica Apple Developer account and
  one Developer ID Application certificate covers all five; only the bundle
  identifier differs per station.
- **Affiliates are separate entities.** Each needs its own Apple Developer
  account, its own Developer ID certificate, and its own Windows certificate.
  Signing an affiliate's app with Pacifica's certificate would name Pacifica as
  the developer of software they don't own.

## What's the same across stations, and what isn't

Every station deployed from this template gets, without touching any code:

- **Its own name, icon and installer artwork** — the desktop app is built and
  signed per station, so it never looks like, or gets mistaken for, another
  station's app.
- **A private dashboard it can turn on or leave off** — a password-gated view
  for the station's own staff, invisible to everyone else until a password is
  set.
- **A say in whether visitor usage is measured at all** — a station can turn
  usage counting off entirely, or leave it on; nothing about a visitor is
  identifiable either way.
- **Its own storage, kept separate** — each station's data is stamped with the
  station's identity, so it can't end up mixed with, or mistaken for, another
  station's.

Not yet turned into a simple per-station setting: which archive, schedule,
artwork and stream sources the app pulls from, the branding and display copy
throughout the app, and the starting set of show descriptions. Today, adapting
these for a new station is a code change rather than a switch to flip.

The technical detail behind all of this — environment variables, file paths,
and exactly what's still hardcoded — is in
[docs/station-config.md](../../../docs/station-config.md).
