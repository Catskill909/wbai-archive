# WBAI Archive — single-stage, zero-dependency Node image.
FROM node:20-alpine

# Run as the unprivileged built-in "node" user.
WORKDIR /app

# Only source is needed; there are no dependencies to install.
COPY package.json ./
COPY server.js ./
COPY public ./public

# Writable spot for the harvested show-info cache. Mount a volume here to keep
# it across redeploys; without one the app just relearns it from the live feed.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

# Lightweight healthcheck hitting the app's own endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
