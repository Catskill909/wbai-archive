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
   - **Persistent storage (recommended):** mount a volume at **`/app/data`**.
     The compose file already declares one. Without it the show-info caches are
     rebuilt after each redeploy — the app works either way, but the program
     directory is re-scraped and the on-air harvest starts from empty.
5. **Health check:** the container defines `HEALTHCHECK` against `/healthz`.
   Coolify will also surface it; no extra config needed.
6. **Deploy.** First load triggers a live scrape of the WBAI archive (cached for
   10 minutes thereafter).

### Notes

- **No build secrets or database.** The only state is caches — in memory, plus
  two rebuildable JSON files under `/app/data`. Deleting them is always safe.
- **Outbound network access is required.** The container must be able to reach
  `archive2.wbai.org`, `confessor2.wbai.org`, `wbai.org`, and
  `streaming.wbai.org` over HTTPS. In restricted networks, allow-list those
  hosts.
- **Scaling:** it's fine to run a single instance. If you run several, each keeps
  its own cache — that's harmless (each just scrapes independently).

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
curl -s https://YOUR-DOMAIN/healthz            # {"ok":true}
curl -s https://YOUR-DOMAIN/api/nowplaying     # current + next show
curl -s https://YOUR-DOMAIN/api/archive | head # {"updated":…,"count":…,"shows":[…]}
curl -s https://YOUR-DOMAIN/api/programs | head -c 200   # {"updated":…,"count":149,…}
```
