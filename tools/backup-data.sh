#!/bin/sh
# Copy the archive's data directory off the container, as a dated tarball.
#
# RUN THIS ON THE VPS THAT HOSTS THE CONTAINER, not on a laptop.
#
# Why bother when the VPS itself is snapshotted: a snapshot restores the whole
# machine, which rolls back every other Coolify app on that host. This gives a
# second path — pull one file back into one volume, with only this container
# stopped. Same reason you keep a spare key as well as a locksmith.
#
# What is actually at stake is `feeds.json`. It accumulates the episodes that
# fall out of upstream's five-item-per-show window, so it is the only copy of
# this station's older listings anywhere; upstream has already forgotten them and
# no re-harvest brings them back. The other files here are caches that refill.
#
#   ./backup-data.sh                      -> ./wbai-data-YYYY-MM-DD.tgz
#   ./backup-data.sh /backups             -> /backups/wbai-data-YYYY-MM-DD.tgz
#   CONTAINER=other-name ./backup-data.sh
#
# Cron it weekly and keep the result somewhere that is not this machine:
#   0 4 * * 0  /opt/wbai/backup-data.sh /backups >> /var/log/wbai-backup.log 2>&1
set -e

CONTAINER="${CONTAINER:-wbai-archive}"
DEST="${1:-.}"
STAMP=$(date +%F)
OUT="$DEST/wbai-data-$STAMP.tgz"

command -v docker >/dev/null 2>&1 || { echo "docker not found — run this on the VPS host"; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "no container named '$CONTAINER'. Set CONTAINER=<name>; docker ps --format '{{.Names}}' to list."
  exit 1
}
mkdir -p "$DEST"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Copy rather than tar-in-place: `docker cp` works on a running container and
# needs no shell inside it (the image is alpine with no tar guarantees).
docker cp "$CONTAINER:/app/data" "$TMP/data"
tar czf "$OUT" -C "$TMP" data

# Report what was actually captured, not just that a file was written. A backup
# whose size nobody looked at is how you discover at restore time that it has
# been archiving an empty directory for six months.
FEEDS="$TMP/data/feeds.json"
if [ -f "$FEEDS" ]; then
  SLUGS=$(node -e "try{console.log(Object.keys(JSON.parse(require('fs').readFileSync('$FEEDS','utf8'))).length)}catch(e){console.log('UNPARSEABLE')}" 2>/dev/null || echo '?')
  echo "$OUT  ($(du -h "$OUT" | cut -f1))  feeds.json: $SLUGS slugs"
  [ "$SLUGS" = "UNPARSEABLE" ] && echo "WARNING: feeds.json in the container does not parse — check /healthz storage.quarantined" >&2
  [ "$SLUGS" = "0" ] && echo "WARNING: feeds.json is EMPTY. Do not overwrite an older backup with this one." >&2
else
  echo "WARNING: no feeds.json in the container's data dir — is the volume mounted?" >&2
  echo "$OUT  ($(du -h "$OUT" | cut -f1))"
fi

# ---------------------------------------------------------------- restoring
# Stop only this container, put the file back, start it. Do NOT restore a whole
# VPS snapshot for this — that rolls back every other app on the host.
#
#   tar xzf wbai-data-YYYY-MM-DD.tgz
#   docker stop wbai-archive
#   docker cp data/feeds.json wbai-archive:/app/data/feeds.json
#   docker start wbai-archive
#   curl -s localhost:8080/healthz    # feedsOnDisk should match the backup
#
# From a VPS snapshot instead of a tarball, the same file lives at
#   /var/lib/docker/volumes/<volume-name>/_data/feeds.json
