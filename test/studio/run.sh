#!/bin/sh
# Studio layout suite — does the dashboard fit the screen?
#
# Separate from studio-tests.js (which is browser-free and runs under
# `npm test`) because this one needs a real layout engine. The bug it exists to
# catch — every panel clipped on the right at phone widths — was invisible to
# every non-visual check we had.
#
#   ./run.sh
#   BASE=https://wbai.supersoul.top STUDIO_PASSWORD=... ./run.sh
set -e
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

BASE=${BASE:-http://localhost:8080}
PASSWORD=${STUDIO_PASSWORD:-local-dev-password}

curl -sf -m 5 "$BASE/healthz" >/dev/null \
  || { echo "the app must be reachable at $BASE"; exit 1; }

# The studio only exists when the server has a password set, so say so clearly
# rather than failing later on a missing login form.
curl -sf -m 5 "$BASE/studio" | grep -q 'loginForm\|storageFacts' \
  || { echo "no studio at $BASE — start the server with STUDIO_PASSWORD set"; exit 1; }

# Per CLAUDE.md §1: name the bundle we are judging, so a stale one is obvious.
echo "studio bundle: $(curl -s "$BASE/healthz" | sed 's/.*"studioVersion":"\([^"]*\)".*/\1/')"

# 9225: live-stream owns 9222, touch 9223, ui 9224. The profile name avoids the
# string "chrome-profile", which test/live-stream's cleanup pkills by substring.
PORT=9225
PROFILE="$PWD/studio-profile"
cleanup() { pkill -f "studio-profile" 2>/dev/null || true; }
trap cleanup EXIT
cleanup
sleep 1
rm -rf "$PROFILE"

"$CHROME" --headless=new --mute-audio \
  --remote-debugging-port=$PORT --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1400,1000 about:blank > chrome.log 2>&1 &

for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.25
done

# Both suites share the one browser. Neither is allowed to hide the other's
# failure, so run them regardless and exit non-zero if either did.
rc=0
for suite in layout-tests.js sort-tests.js; do
  echo
  echo "--- $suite"
  CDP_PORT=$PORT BASE="$BASE" STUDIO_PASSWORD="$PASSWORD" \
    node --experimental-websocket "$suite" || rc=1
done
exit $rc
