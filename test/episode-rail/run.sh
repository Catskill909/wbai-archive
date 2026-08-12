#!/bin/sh
# Drives the unmodified app in headless Chrome and exercises the show sheet's
# internal Past episodes route, listening-history states, and persistent player
# dock. The directory keeps its old name so existing local commands stay valid.
#
# Needs the app running on :8080 with real listing data; the fixtures are DERIVED
# from whatever that listing currently holds (see pickFixtures) rather than
# hardcoded, because every episode id in the archive rotates out within ~60 days.
set -e
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

BASE="${BASE:-http://localhost:8080}"
curl -sf -m 15 "$BASE/healthz" >/dev/null \
  || { echo "the app is not healthy at $BASE"; exit 1; }

PROFILE="${TMPDIR:-/tmp}/wbai-rail-chrome-profile"
cleanup() { pkill -f "$PROFILE" 2>/dev/null || true; }
trap cleanup EXIT
cleanup
sleep 1
rm -rf "$PROFILE"

# Port 9224, not the live suite's 9222, so both can be up at once.
"$CHROME" --headless=new --mute-audio \
  --remote-debugging-port=9224 \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1400,1000 about:blank > chrome.log 2>&1 &

# Chrome startup occasionally takes longer after several headless suites have
# run. Wait for the actual CDP target instead of guessing with a fixed sleep.
i=0
while [ $i -lt 40 ]; do
  curl -sf -m 1 http://127.0.0.1:9224/json/list >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 0.25
done

# Node 20 needs the flag for a WebSocket client; Node 21+ has it natively.
BASE="$BASE" node --experimental-websocket rail-tests.js 2>&1 \
  | grep -v ExperimentalWarning | grep -v 'Use \`node'
