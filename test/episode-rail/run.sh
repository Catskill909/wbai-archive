#!/bin/sh
# Drives the unmodified app in headless Chrome and exercises the show sheet's
# episode rail — the date chips that let a listener reach the other episodes of
# the show they are looking at. See rail-tests.js for what is asserted and why.
#
# Needs the app running on :8080 with real listing data; the fixtures are DERIVED
# from whatever that listing currently holds (see pickFixtures) rather than
# hardcoded, because every episode id in the archive rotates out within ~60 days.
set -e
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

curl -sf -m 3 http://localhost:8080/healthz >/dev/null \
  || { echo "the app must be running on :8080 (node server.js)"; exit 1; }

cleanup() { pkill -f "rail-chrome-profile" 2>/dev/null || true; }
trap cleanup EXIT
cleanup
sleep 1
rm -rf rail-chrome-profile

# Port 9224, not the live suite's 9222, so both can be up at once.
"$CHROME" --headless=new --mute-audio \
  --remote-debugging-port=9224 \
  --user-data-dir="$PWD/rail-chrome-profile" \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1400,1000 about:blank > chrome.log 2>&1 &
sleep 3.5

# Node 20 needs the flag for a WebSocket client; Node 21+ has it natively.
node --experimental-websocket rail-tests.js 2>&1 \
  | grep -v ExperimentalWarning | grep -v 'Use \`node'
