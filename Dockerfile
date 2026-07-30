# WBAI Archive — single-stage, zero-dependency Node image.
FROM node:24-alpine

# Run as the unprivileged built-in "node" user.
WORKDIR /app

# Only source is needed; there are no dependencies to install.
COPY package.json ./
COPY server.js ./
COPY public ./public

# The studio's HTML. Deliberately NOT under public/ — anything in that directory
# is served to anyone who asks, which would let /studio.html walk straight around
# the password gate. Only an authenticated route ever reads these.
COPY admin ./admin

# Starting set for the show-info cache. Kept outside /app/data because a mounted
# volume shadows the image's copy of that directory — the server merges this in
# at boot so a fresh deploy has descriptions immediately instead of waiting for
# the whole schedule to rotate past the on-air feed.
COPY seed ./seed

# Writable spot for everything the server persists (DATA_DIR, default /app/data).
#
# There is deliberately NO `VOLUME ["/app/data"]` here. That instruction sounds
# like it asks for persistence and does the opposite when no explicit mount is
# supplied: Docker then creates an *anonymous* volume, a new one per container,
# so data survives restarts and is thrown away on the next deploy — invisible in
# any UI, and the exact symptom this deployment showed (CLAUDE.md §4, and
# docs/admin-page.md §5.3). Persistence comes from an explicit mount instead:
# Coolify → Storages → Volume Mount → /app/data. Verify with /healthz; do not
# assume. Without a mount the app still runs and relearns from the live feed,
# starting from the seed above.
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

# Lightweight healthcheck hitting the app's own endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
