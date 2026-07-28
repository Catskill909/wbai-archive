#!/bin/sh
# Link-preview (Open Graph) suite — what a crawler gets when someone shares an
# episode. Needs no browser and no fake station, just the app on :8080.
#
#   ./run.sh
#   BASE=https://wbai.supersoul.top ./run.sh    # point it at production
set -e
cd "$(dirname "$0")"

BASE=${BASE:-http://localhost:8080}

curl -sf -m 5 "$BASE/healthz" >/dev/null \
  || { echo "the app must be reachable at $BASE (node server.js)"; exit 1; }

# Per CLAUDE.md §1: name the bundle we are judging, so a stale one is obvious.
echo "app version: $(curl -s "$BASE/healthz" | sed 's/.*"version":"\([^"]*\)".*/\1/')"
echo "base: $BASE"

BASE="$BASE" exec node og-tests.js
