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

## What the server side already parameterizes

Only the desktop shell reads *these* profiles, but the server a station deploys
is no longer entirely hardcoded. As of 2026-07-30 it takes four environment
variables, each with a working default, and the full annotated list is
[`.env.example`](../../../.env.example):

| Variable | Per station |
| --- | --- |
| `STATION_ID` | Which station this deployment is. Stamped into `.instance.json` so a data volume restored or attached to the wrong app is caught rather than silently merged. |
| `DATA_DIR` | Everything the server persists, under one path — the same string as the volume mount. One setting, not three. |
| `STUDIO_PASSWORD` | Enables that station's private view at `/studio`. Unset and the routes do not exist at all, which is the right default for a station that doesn't want one. |
| `STUDIO_SECRET`, `STUDIO_SESSION_HOURS` | Optional session tuning. |
| `USAGE_TRACKING` | Whether to count plays, live tune-ins, page views, searches and shares at all. `off` and the ingest route is never registered — nothing is counted. |

The rule these follow, and the one to keep following: **a per-station difference
should be a setting, never a code edit.** The moment it is a code edit, every
station is a fork, and forks do not get each other's fixes.

Storage in particular has a station-independent gotcha worth reading before the
second deployment: Coolify has been observed ignoring the compose `volumes:`
block, and a Dockerfile `VOLUME` line with no explicit mount silently creates a
throwaway anonymous volume. `/healthz` now reports `storage.mounted` and
`storage.instanceId` so this is *read* rather than assumed. See
[DEPLOYMENT.md](../../../docs/DEPLOYMENT.md) step 5.

## What is still not parameterized

The web app the shell points at still has the station baked into its **content**:

- the upstream hosts in the `UPSTREAM` object in `server.js` — the biggest piece,
  since every station has its own archive, schedule, artwork and stream hosts;
- display copy, the station name and logo, and the non-affiliation notice across
  `public/`;
- `seed/showinfo.json`, which is WBAI's harvested descriptions;
- the studio's own header, which reads `STATION_ID` for the badge but nothing
  else.

A profile here only renames the window around all of that. The full plan is
item 4 in [ROADMAP.md](../../../docs/ROADMAP.md).
