# Station server configuration (technical reference)

The plain-language version of what this covers is in
[desktop/src-tauri/stations/README.md](../desktop/src-tauri/stations/README.md#whats-the-same-across-stations-and-what-isnt).
This doc is the technical detail behind it: the env vars, files and code paths.

## Environment variables

Only the desktop shell reads the `stations/*.json` profiles, but the server a
station deploys is no longer entirely hardcoded. As of 2026-07-30 it takes four
environment variables, each with a working default. The full annotated list is
[`.env.example`](../.env.example):

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
[DEPLOYMENT.md](DEPLOYMENT.md) step 5.

## What is still not parameterized

The web app the shell points at still has the station baked into its **content**:

- the upstream hosts in the `UPSTREAM` object in `server.js` — the biggest piece,
  since every station has its own archive, schedule, artwork and stream hosts;
- display copy, the station name and logo, and the non-affiliation notice across
  `public/`;
- `seed/showinfo.json`, which is WBAI's harvested descriptions;
- the studio's own header, which reads `STATION_ID` for the badge but nothing
  else.

A profile in `desktop/src-tauri/stations/` only renames the window around all of
that. The full plan is item 4 in [ROADMAP.md](ROADMAP.md).
