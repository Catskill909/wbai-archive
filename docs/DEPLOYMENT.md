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
4. **Environment variables (optional):**
   - `PORT` — defaults to `8080`; leave unless you have a reason to change it.
   - `NODE_ENV=production` — already set in the image.
   - `PROGRAMS_PATH` / `SHOWINFO_PATH` — where the show-info caches are written;
     default `/app/data/*.json`.
   - `SEED_PATH` — the read-only starting set merged into the show-info cache at
     boot; default `/app/seed/showinfo.json`. Rarely worth changing.
   - **Persistent storage (recommended):** mount a volume at **`/app/data`**.
     The compose file already declares one. Without it the show-info caches are
     rebuilt after each redeploy — the app works either way, but the program
     directory is re-scraped and the on-air harvest restarts from the seed rather
     than from everything the instance had learned since its last deploy.

   **To check the volume is actually mounted, ask the server** — `/healthz`
   reports what it found on disk at boot, before the seed was merged in:

   ```sh
   curl -s https://<host>/healthz
   ```

   | `storage` shows | Means |
   | --- | --- |
   | `writable:true, showinfoOnDisk:>0` | Volume mounted and a previous run's cache survived. Correct. |
   | `writable:true, showinfoOnDisk:0` | Writable, but nothing carried over. Expected on the very first boot; **on any later redeploy it means the volume is not persisting.** |
   | `writable:false` | The data dir can't be written at all — caches are memory-only and nothing will ever survive. Check mount permissions (the container runs as uid `node`). |

   `showinfoNow` is the count after seeding, so it will read ~47 even with no
   volume — compare `showinfoOnDisk`, not `showinfoNow`.
5. **Health check:** the container defines `HEALTHCHECK` against `/healthz`.
   Coolify will also surface it; no extra config needed.
6. **Deploy.** First load triggers a live scrape of the WBAI archive (cached for
   5 minutes thereafter).

### Notes

- **No build secrets or database.** The only state is caches — in memory, plus
  two rebuildable JSON files under `/app/data`. Deleting them is always safe.
- **Outbound network access is required.** The container must be able to reach
  `archive2.wbai.org`, `confessor2.wbai.org`, `wbai.org`, and
  `streaming.wbai.org` over HTTPS. In restricted networks, allow-list those
  hosts.
- **Scaling:** it's fine to run a single instance. If you run several, each keeps
  its own cache — that's harmless (each just scrapes independently).
- **Don't trust the volume until you've read `showinfoOnDisk`.** Declaring a
  volume in `docker-compose.yml` is not proof one is mounted — Coolify has been
  observed ignoring it. See [Troubleshooting](#coolify-ignores-the-compose-volumes-block).

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
{"ok":true,"version":"…","storage":{"writable":true,"showinfoOnDisk":0,"showinfoNow":47}}
```

- **`version`** — must change after a deploy. If it doesn't, the old image is
  still running and nothing you're looking at reflects your changes.
- **`storage.showinfoOnDisk`** — records read from the data dir *before* the seed
  was merged. This is the only field that tells you whether persistent storage is
  really working. See the volume table under [Deploy on Coolify](#deploy-on-coolify).
- **`storage.showinfoNow`** — count after seeding. Reads ~47 whether or not a
  volume is mounted, so it diagnoses nothing. Don't use it.

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

**As of 2026-07-26 this no longer costs anything visible.** Since
`GET /api/showinfo/<altid>` resolves a description on demand for any show, a
server that starts with an empty data dir fills itself in as visitors browse. The
volume is now purely an optimisation — it saves repeat lookups across a redeploy,
nothing more. Configure it if it's easy; ignore it if it isn't.

**To confirm a fix**, redeploy and read `showinfoOnDisk` again. It should come
back at or above the seed size (47) rather than 0. Because the seed makes every
other count look healthy, `showinfoOnDisk` at boot is the only honest signal —
which is precisely why it's exposed.
