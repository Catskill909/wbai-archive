# Deployment

The app is a single container that listens on **port 8080** (override with the
`PORT` env var). Put a TLS-terminating reverse proxy in front of it — Coolify
does this for you.

## Deploy on Coolify

1. **New Resource → Application → Public/Private Git Repository.**
   Point it at `https://github.com/Catskill909/wbai-archive` (branch `main`).
2. **Build Pack: Dockerfile.** The repo's `Dockerfile` builds a
   `node:20-alpine` image that runs as a non-root user.
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

**None of this can be checked locally.** With no container there is no mount to
fail: `./data` persists across restarts unconditionally, `freshVolume` goes
false after the first run, and `instanceId` never changes. Locally these fields
confirm the code works. Only the deployed host can tell you the storage does.

## Troubleshooting

### Descriptions missing from the info sheet

A show's description comes from `/api/showinfo`, harvested from the on-air feed —
and that feed only exposes rich records for the show **on air** and the one **up
next**. A server therefore learns a show's description only while that show is
broadcasting. wbai.org's program directory (`/api/programs`) covers some shows
but not all; "WBAI Sports", for instance, isn't listed there at all, so the
harvest is its only possible source.

This is why the image ships `seed/showinfo.json` — see
[ARCHITECTURE.md](ARCHITECTURE.md#get-apishowinfo). If descriptions are missing
in production but present locally, compare the two counts:

```bash
curl -s http://localhost:8080/api/showinfo | head -c 40
curl -s https://YOUR-DOMAIN/api/showinfo  | head -c 40
```

A production count far below the seed's means the seed didn't ship — check that
`COPY seed ./seed` is still in the `Dockerfile` and that `seed/` isn't excluded by
`.dockerignore` (note `data/` *is* gitignored; `seed/` deliberately is not).
Refresh the seed from a long-running instance with `npm run seed`, then commit.

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
