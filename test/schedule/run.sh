#!/bin/sh
# The schedule modal's on-air row and its chooser, in headless Chrome against
# the running app. See sched-tests.js for the contract and why it exists.
set -e
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

curl -sf -m 3 http://localhost:8080/healthz >/dev/null \
  || { echo "the app must be running on :8080 (node server.js)"; exit 1; }

cleanup() { pkill -f "sched-chrome-profile" 2>/dev/null || true; }
trap cleanup EXIT
cleanup
sleep 1
rm -rf sched-chrome-profile

# Port 9225: clear of live-stream 9222, touch 9223 and episode-rail 9224.
"$CHROME" --headless=new --mute-audio \
  --remote-debugging-port=9225 \
  --user-data-dir="$PWD/sched-chrome-profile" \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1400,1000 about:blank > chrome.log 2>&1 &
sleep 3.5

# Node 20 needs the flag for a WebSocket client; Node 21+ has it natively.
node --experimental-websocket sched-tests.js 2>&1 \
  | grep -v ExperimentalWarning | grep -v 'Use \`node'
