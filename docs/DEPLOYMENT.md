# Deployment

The app is a single container that listens on **port 8080** (override with the
`PORT` env var). Put a TLS-terminating reverse proxy in front of it — Coolify
does this for you.

## Deploy on Coolify

1. **New Resource → Application → Public/Private Git Repository.**
   Point it at `https://github.com/Catskill909/wbai-archive` (branch `main`).
2. **Build Pack: Dockerfile.** The repo's `Dockerfile` builds a
   `node:24-alpine` image that runs as a non-root user.
   - Alternatively choose **Docker Compose** and Coolify will use
     `docker-compose.yml`.
3. **Port:** set the exposed/container port to **8080**. Coolify maps its proxy
   (Traefik) to it and issues a Let's Encrypt certificate for your domain.
4. **Environment variables.** Every one has a working default; the full list
   with comments is [`.env.example`](../.env.example).
   - `PORT` — defaults to `8080`; leave unless you have a reason to change it.
   - `STATION_ID` — which station this deployment is (`wbai`). Stamped into the
     data files so a volume attached to the wrong app is caught rather than
     silently merged.
   - `DATA_DIR` — **the only storage setting.** Everything the server persists
     lives under it, and it is the same string as the mount path in step 5.
     Defaults to `/app/data`; leave it alone.
   - `STUDIO_PASSWORD` — enables the station view at `/studio`. **Leave it unset
     and the feature does not exist**: the routes are never registered, so
     `/studio` falls through like any other unknown path rather than showing a
     login form to anyone who scans for one. Use 12+ characters. Rotating it
     signs everyone out, which is the only revocation there is — see
     [admin-page.md](admin-page.md) §3.
   - `STUDIO_SECRET` / `STUDIO_SESSION_HOURS` — optional; see
     [`.env.example`](../.env.example).
   - `USAGE_TRACKING` — defaults to `on`. Counts plays, live tune-ins, page
     views, searches and shares, with **no cookie, no session and no stored or
     hashed IP**. Set to `off` and the ingest route is never registered, so
     nothing is counted. Rollups live in `DATA_DIR/stats/` — the only data here
     that no upstream can give back, so the volume in step 5 matters for it.
   - `NODE_ENV=production` — already set in the image.
   - `SEED_PATH` — the read-only starting set merged into the show-info cache at
     boot; default `/app/seed/showinfo.json`. Lives outside `DATA_DIR` on
     purpose — a mounted volume shadows whatever the image put at that path.
     Rarely worth changing.
5. **Persistent storage — set it in the UI, not in a file.**

   In the application → **Storages** → **Add Persistent Storage** → type
   **Volume Mount**, name `wbai-archive-data`, destination path **`/app/data`**.

   Do this even though `docker-compose.yml` declares a volume and even though
   the Dockerfile has a writable `/app/data`. **Neither is proof of anything.**
   Coolify has been observed ignoring the compose `volumes:` block entirely, and
   a Docker `VOLUME` instruction with no explicit mount creates a fresh
   *anonymous* volume per container — data then survives restarts and is
   discarded on the next deploy, invisibly. That combination cost this project
   weeks of a data dir that looked fine and reset every time.

   Without a mount the app still runs: the caches rebuild from the live feed
   after each deploy, starting from the seed rather than from everything the
   instance had learned. Once analytics ship (docs/admin-page.md §5) it stops
   being harmless — that data cannot be re-fetched from anywhere.
6. **Deploy — then verify the storage, before you trust it.**

   `/healthz` reports the volume's identity so this is *read*, not deduced:

   ```sh
   curl -s https://<host>/healthz | grep -o '"storage":{[^}]*}'
   ```

   **On this first deploy** — these are answered immediately, with no history:

   | `storage` shows | Means |
   | --- | --- |
   | `mounted:false` | **Broken, and you know it now.** Nothing is mounted at `DATA_DIR`; it is the container's own layer and everything written there dies with the container. Go back to step 5. |
   | `mounted:true`, `anonymousVolume:true` | **Broken.** A volume exists but Docker named it itself (64 hex characters) — that is an anonymous volume, replaced on the next deploy. This was the original bug. |
   | `mounted:true`, `volume:"wbai-archive-data"` | Correct so far: a real, named mount is in place. |
   | `mounted:null` | Couldn't look (no `/proc` — you are not in a Linux container). Expected locally, unexpected in production. |
   | `writable:false` | The data dir can't be written at all. Check mount permissions (the container runs as uid `node`). |

   **On the next deploy** — this is the one that proves it, because only a second
   boot can show that what the first boot wrote came back:

   | `storage` shows | Means |
   | --- | --- |
   | `instanceId` **unchanged** from the previous deploy | The same directory came back. This is the proof. |
   | `instanceId` **changed** | The volume was replaced, whatever the UI says. |
   | `freshVolume:true` on any deploy after the first | Same failure, stated directly: the data dir was empty again. |
   | `persistedSince` older than `bootedAt` | The directory has outlived at least one deploy. |

   The reason it takes two: on the deploy where you *create* the volume it is
   necessarily empty, and an empty new volume is indistinguishable from no
   volume by looking at its contents. `mounted` sidesteps that by asking the
   kernel what is attached rather than reading files — so a first deploy can now
   **disprove** persistence on the spot, and only confirming it has to wait.

   The server also logs one `[storage] …` line at boot saying all of this in
   English, visible in Coolify's log stream.

   `showinfoOnDisk` remains as detail, but it counts records and a count can be
   zero or non-zero for unrelated reasons — `instanceId` is the diagnostic.
7. **Health check:** the container defines `HEALTHCHECK` against `/healthz`.
   Coolify will also surface it; no extra config needed.
8. First load triggers a live scrape of the WBAI archive (cached for 5 minutes
   thereafter).

### Deployed show-modal smoke test

The routed Show/Past episodes browser suite can exercise the deployed site with
the same isolated Chrome profile and current-data fixtures used locally:

```sh
BASE=https://wbai.supersoul.top test/episode-rail/run.sh
```

This performs real navigation and an archive-media play request, but Chrome is
muted: it proves source handoff, transport state, identity, layout and listening
memory—not audible output. Confirm sound once on a real browser/phone after a
player release. On 2026-08-12, commit `4b6f352` passed 65/65 in production and
the deployed JS/CSS hashes matched that commit exactly.

### Notes

- **No build secrets or database.** The only state is caches — in memory, plus
  three rebuildable JSON files under `DATA_DIR`. Deleting them is always safe.
  The one file that is *not* a cache is `.instance.json`, the volume marker from
  step 6; deleting it costs nothing but resets the persistence evidence.
- **Local runs cannot tell you anything about production storage.** Locally
  `DATA_DIR` is `./data`, an ordinary directory with no container boundary to
  survive, so every storage check passes by construction. A local pass proves
  the code path runs; only step 6 against the deployed host proves the storage.
  See [admin-page.md](admin-page.md) §5.1.
- **Outbound network access is required.** The container must be able to reach
  `archive2.wbai.org`, `confessor2.wbai.org`, `wbai.org`, and
  `streaming.wbai.org` over HTTPS. In restricted networks, allow-list those
  hosts.
- **Scaling:** it's fine to run a single instance. If you run several, each keeps
  its own cache — that's harmless (each just scrapes independently).
- **Don't trust the volume until you've compared `instanceId` across two
  deploys.** Declaring a volume in `docker-compose.yml` is not proof one is
  mounted — Coolify has been observed ignoring it. See step 6 and
  [Troubleshooting](#coolify-ignores-the-compose-volumes-block).

## Deploy with plain Docker

```bash
docker build -t wbai-archive .
docker run -d --name wbai-archive -p 8080:8080 --restart unless-stopped wbai-archive
```

## Deploy with Docker Compose

```bash
docker compose up -d --build
```

## Run without Docker

Requires Node 18+ (built-in `fetch`). There are no dependencies to install.

```bash
PORT=8080 node server.js
```

Then front it with nginx/Caddy for TLS, e.g. a Caddy one-liner:

```
archive.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

## Verifying a deployment

```bash
curl -s https://YOUR-DOMAIN/healthz            # version + storage facts (see below)
curl -s https://YOUR-DOMAIN/api/nowplaying     # current + next show
curl -s https://YOUR-DOMAIN/api/archive | head # {"updated":…,"count":…,"shows":[…]}
curl -s https://YOUR-DOMAIN/api/programs | head -c 200   # {"updated":…,"count":149,…}
curl -s https://YOUR-DOMAIN/api/showinfo | head -c 40    # {"updated":…,"count":47,…}
```

`/healthz` is the one to read carefully — it reports the bundle version *and*
what the server found on disk at boot:

```json
{"ok":true,"version":"…","station":"wbai","storage":{
  "dataDir":"/app/data","writable":true,
  "mounted":true,"volume":"wbai-archive-data","anonymousVolume":false,
  "instanceId":"3f2b…","persistedSince":1785450000000,"bootedAt":1785460000000,
  "freshVolume":false,"showinfoOnDisk":47,"showinfoNow":47}}
```

- **`version`** — must change after a deploy. If it doesn't, the old image is
  still running and nothing you're looking at reflects your changes.
- **`storage.mounted` / `volume` / `anonymousVolume`** — what the kernel says is
  attached at `DATA_DIR`, readable on the *first* deploy. `false` means no
  volume at all; a 64-hex `volume` name means an anonymous one that the next
  deploy will discard. `null` means the probe couldn't look (no `/proc`, i.e.
  not a Linux container) — unknown, not absent.
- **`storage.instanceId`** — the volume's identity. **Unchanged across a
  redeploy is the proof that persistent storage works**; a new value means the
  directory was replaced. Confirming needs two deploys; `mounted` above is what
  lets a single one already tell you it's broken.
- **`storage.freshVolume`** — this boot found an empty data dir. True is correct
  exactly once, on the first ever deploy; true on any later one means the volume
  is not persisting.
- **`storage.persistedSince`** — when the current data dir was first written.
  Older than `bootedAt` means it outlived at least one deploy.
- **`storage.showinfoOnDisk`** — records read from the data dir *before* the seed
  was merged. Useful detail, but it counts records; `instanceId` is the
  diagnostic. See the table under [Deploy on Coolify](#deploy-on-coolify).
- **`storage.showinfoNow`** — count after seeding. Reads ~47 whether or not a
  volume is mounted, so it diagnoses nothing. Don't use it.
- **`storage.quarantined`** — normally `[]`, and the one field here that is an
  alarm rather than a measurement. A non-empty list means a file on the volume
  would not parse at boot and its bytes were renamed aside
  (`feeds.json.corrupt-<timestamp>`) rather than left to be overwritten. The
  server is running on an empty store for that file, so whatever it had
  accumulated now exists **only** in the quarantined copy. Act on it before the
  next harvest widens the gap — see
  [Protecting the data directory](#protecting-the-data-directory).

**None of this can be checked locally.** With no container there is no mount to
fail: `./data` persists across restarts unconditionally, `freshVolume` goes
false after the first run, and `instanceId` never changes. Locally these fields
confirm the code works. Only the deployed host can tell you the storage does.

## Protecting the data directory

Since 2026-08-07 the data directory is **not a cache**. `feeds.json` accumulates
the episodes that fall out of upstream's five-item-per-show window
(`mergeFeedItems`), so it holds listings that exist nowhere else — not upstream,
not in the repo, not in the image. A re-harvest cannot rebuild it, because the
source has already forgotten. Treat losing it as permanent.

Everything about this failure is quiet. An emptied volume is indistinguishable
from a first boot: the app starts, serves, and refills with whatever the current
window holds. There is no crash to notice.

Four layers, and none of them substitutes for another.

### 0. At boot — an unreadable `feeds.json` is quarantined, not discarded

`readJsonFile` throws away anything it cannot parse and returns the fallback,
which is correct for a cache and was catastrophic here: start from `{}` and the
next harvest writes a thin store straight over the thick one, about ten seconds
later. `feeds.json` therefore loads through `readIrreplaceableJson`, which
separates the two ways of reaching "empty":

- **absent** — a first boot, or a volume already replaced. Nothing to save;
  proceed as before, and `storage.freshVolume` reports it.
- **exists but will not parse** — the bytes on disk are worth more than this
  process's opinion of them. They are renamed to
  `feeds.json.corrupt-<timestamp>` and the app carries on with an empty store.

Quarantine rather than refusing to write, deliberately: refusing would preserve
the file but leave the server unable to persist anything until a human noticed,
trading a rare recoverable problem for a guaranteed outage. A rename needs no
free space and keeps every byte — a truncated JSON usually still holds nearly
all its records, so recovery is a repair job rather than a loss. It also removes
the corrupt file from the path the next atomic write would replace, which is
what made the bad bytes the last copy and then no copy at all.

It is loud: an error in the log and `storage.quarantined` in `/healthz`. It still
needs a person — the quarantined file is now the only copy of whatever it held.
Suite: `test/feeds-quarantine/`, which boots real servers against throwaway data
dirs and checks the disk afterwards, because "the bytes still exist" is not
something reading the source can establish.

### 1. Before the commit — `npm run check:storage`

Installed as a pre-commit hook by `npm run hooks:install` (once per clone; git
does not carry hooks). It checks the **staged** content and refuses the commit on
anything that could cost the volume:

| Rule | What it catches |
| --- | --- |
| `dockerfile-no-volume` | A `VOLUME` line — creates a fresh anonymous volume per container. The historical bug. |
| `dockerfile-no-bulk-copy` | `COPY . .` / `ADD .` — bakes a developer's local `data/` into the image. |
| `dockerfile-no-data-removal` | A `RUN` that deletes `/app/data` — runs on every build. |
| `data-dir-default` | `DATA_DIR` no longer resolving from the env with `./data` as fallback: the mount stays put and the app writes elsewhere. |
| `seed-outside-data-dir` | A seed under `DATA_DIR`, where the mount shadows it. |
| `no-raw-writes-to-persisted-paths` | `writeFileSync`/`unlinkSync`/`rmSync` on a persisted path instead of `writeJsonAtomic`. |
| `compose-mount-matches-data-dir` | `DATA_DIR` and the mount target drifting apart. |
| `gitignore-protects-data` / `dockerignore-excludes-data` | `data/` becoming trackable or copyable. |
| `no-staged-data-files` | Live station data staged for commit. |

Override a single line with a `storage-safety:allow` comment — recorded next to
the thing it excuses — rather than `git commit --no-verify`, which leaves no
trace. Self-test: `node test/storage-guard/selftest.js`, part of `npm test`; it
breaks every rule on a fixture and requires the guard to notice, because a guard
that has never failed has not been shown to work.

**It is static config analysis and nothing more.** It cannot tell you the volume
is mounted. Passing it says only that this commit does not contain a known way of
losing the data.

### 2. After the deploy — read `/healthz`

Per CLAUDE.md §4 a local pass is *no* evidence here; there is no container
boundary on a laptop, so every storage check passes by construction. The one
question worth asking is whether `storage.instanceId` is **the same value as
before the deploy** — same id, same directory. See
[Verifying a deployment](#verifying-a-deployment) for the rest of the fields and
which ones lie.

Take the reading *before* deploying too, or there is nothing to compare against:

```bash
curl -s https://YOUR-DOMAIN/healthz | sed 's/.*"instanceId":"\([^"]*\)".*/\1/'
```

### 3. Keep two restore paths, and prefer the narrow one

Neither Coolify nor the app backs anything up. The image carries only
`seed/showinfo.json` — show descriptions, not listings — so nothing inside this
stack holds `feeds.json`. Backup therefore comes from the host, and it is worth
having **two** ways back rather than one.

**Path 1 — file-level (preferred).** `tools/backup-data.sh`, run on the VPS:

```bash
./tools/backup-data.sh /backups        # -> /backups/wbai-data-YYYY-MM-DD.tgz
```

It reports the slug count it captured, and warns if `feeds.json` is empty or
unparseable — a backup whose size nobody looked at is how you find out at restore
time that it has been archiving an empty directory for six months. Weekly cron:

```
0 4 * * 0  /opt/wbai/backup-data.sh /backups >> /var/log/wbai-backup.log 2>&1
```

Restoring touches **only this app**:

```bash
tar xzf wbai-data-YYYY-MM-DD.tgz
docker stop wbai-archive
docker cp data/feeds.json wbai-archive:/app/data/feeds.json
docker start wbai-archive
curl -s localhost:8080/healthz         # feedsOnDisk should match the backup
```

**Path 2 — VPS snapshot (last resort).** A host-level snapshot already contains
`/var/lib/docker/volumes/`, so the volume is in it. But restoring one rolls the
whole machine back, taking **every other Coolify app on that host** with it —
which is precisely why path 1 is worth maintaining alongside it. To recover a
single file from a snapshot without restoring the machine, mount it and pull:

```
/var/lib/docker/volumes/<volume-name>/_data/feeds.json
```

Snapshots taken mid-write are safe: writes are atomic, and an unparseable file is
quarantined at boot (§0) rather than overwritten, so restoring a torn one cannot
silently destroy it.

A copy taken *after* the volume was replaced is a copy of nothing — check
`freshVolume` first.

The same applies locally: `./data` is gitignored, so `git clean -xdf` deletes it
and your laptop's accumulated `feeds.json` with it.

## Troubleshooting

### Descriptions missing from the show modal

The Show view first reads `/api/showinfo`, whose warm cache is harvested from the
on-air/up-next feed and seeded by `seed/showinfo.json`. It then falls back to the
title-matched `/api/programs` directory. If neither already describes the show,
opening its profile asks `/api/showinfo/<altid>` for that show on demand and
repaints when the result lands. A slow or failed upstream request can therefore
leave one opening sparse without blocking the modal.

These are program descriptions, not episode notes. Changing dates within one
show should keep the same description; changing shows should resolve the new
show. The podcast XML often repeats its main channel blurb on every item and is
not treated as unique episode copy.

If descriptions are broadly missing in production but present locally, compare
the warm-cache counts:

```bash
curl -s http://localhost:8080/api/showinfo | head -c 40
curl -s https://YOUR-DOMAIN/api/showinfo  | head -c 40
```

A production count far below the seed's means the warm start may not have
shipped — check that
`COPY seed ./seed` is still in the `Dockerfile` and that `seed/` isn't excluded by
`.dockerignore` (note `data/` *is* gitignored; `seed/` deliberately is not).
Refresh the seed from a long-running instance with `npm run seed`, then commit.
For one specific show, also inspect
`/api/showinfo/<url-encoded-altid>`; see
[ARCHITECTURE.md](ARCHITECTURE.md#get-apishowinfoaltid--the-gap-filler).

### Coolify ignores the compose `volumes:` block

> **RESOLVED on `wbai.supersoul.top`, 2026-07-30.** Adding Persistent Storage in
> the Storages UI (step 5) fixed it. Two consecutive deploys reported the same
> `storage.instanceId` with `freshVolume:false`, and `showinfoOnDisk`/
> `feedsOnDisk` came back at 49/122 rather than 0/0. The history below is kept
> because the diagnosis is the reusable part — every station standing up this
> template will meet the same trap.

**Confirmed on `wbai.supersoul.top`, 2026-07-26.** `docker-compose.yml` declares
`wbai-data:/app/data`, but after a redeploy `/healthz` reported:

```json
"storage": {"writable": true, "showinfoOnDisk": 0, "showinfoNow": 47}
```

The previous container had harvested 2 records and run ~40 minutes — well past the
10-second debounce, so they were certainly written to `/app/data/showinfo.json`.
Reading back **0** means the directory was fresh again: the volume is not
persisting. `writable: true` rules out a permissions problem.

Coolify does not reliably act on a compose `volumes:` block; persistent storage
generally has to be added in its own **Storages** panel, mapped to `/app/data`.

**Probable mechanism, found 2026-07-30.** The `Dockerfile` used to end its data
stanza with `VOLUME ["/app/data"]`. That instruction does not request
persistence — with no explicit mount for the path, Docker creates an *anonymous*
volume, a new one for every container. Data then survives restarts perfectly and
is discarded on the next deploy, with nothing in any UI to see. That is exactly
the observed symptom, and it is why the `VOLUME` line has now been removed:
persistence has to come from a real mount, and nothing should look like it might
be providing it instead.

**How much this costs has changed.** It was written off in July as an
optimisation, on the grounds that `GET /api/showinfo/<altid>` refills
descriptions on demand as visitors browse — true, and still true. But every file
under `DATA_DIR` was rebuildable when that was written. The analytics rollups in
[admin-page.md](admin-page.md) §5 are not: they are the first data this app has
had that no upstream can return. Before that ships, the volume stops being
optional.

**To confirm a fix**, deploy twice and compare `storage.instanceId` across the
two. Same value = the same directory came back, which is the only thing that
proves persistence; a new value = still broken. One deploy cannot tell you,
because a fresh volume looks identical to a persisting one until the moment it
is replaced. `freshVolume:true` on any deploy after the first says the same
thing more directly.
