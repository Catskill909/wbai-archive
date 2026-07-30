# Station profiles

One file per station. Each is a **partial** `tauri.conf.json`, merged over the
base by `tauri build --config stations/<slug>.json`, so it carries only what
differs between stations: the name, the bundle identifier, the store copy and
the copyright line.

```bash
STATION_URL=https://archive.wbai.org STATION_NAME="WBAI 99.5 FM Archive" \
  npm run build -- --config stations/wbai.json
```

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
4. Point `STATION_URL` at that station's own deployment.

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

## What is not parameterized yet

Only the desktop shell reads these profiles. The web app it points at still has
the station baked in — the upstream hosts at `server.js` (the `UPSTREAM` object),
plus display copy and the non-affiliation notice in `public/`. A second station
needs that work too; a profile here only renames the window around it.
