#!/bin/sh
# Runs the touch-affordance suite against the app on :8080.
#
# Unlike test/live-stream, this needs no fake station — it asserts CSS and DOM
# behaviour, not audio. It DOES need CDP pointer emulation, because headless
# Chrome is a fine-pointer device by default and would leave the whole touch
# layer inert. See docs/touch-dev.md §5.
set -e
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

curl -sf -m 3 http://localhost:8080/healthz >/dev/null \
  || { echo "the app must be running on :8080 (node server.js)"; exit 1; }

# Report the bundle the browser is about to be handed. Per CLAUDE.md §1, a
# touch result judged against a stale bundle is worthless.
echo "app version: $(curl -s http://localhost:8080/healthz | sed 's/.*"version":"\([^"]*\)".*/\1/')"

# Port 9223, not 9222: test/live-stream uses 9222, and its cleanup does
# `pkill -f "chrome-profile"` which also matches this profile name. Separate
# port + distinct profile means the two suites can never fight over a browser.
cleanup() { pkill -f "chrome-profile-touch" 2>/dev/null || true; }
trap cleanup EXIT
cleanup
sleep 1
rm -rf chrome-profile-touch

"$CHROME" --headless=new --mute-audio \
  --remote-debugging-port=9223 \
  --user-data-dir="$PWD/chrome-profile-touch" \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1400,1000 about:blank > chrome.log 2>&1 &
sleep 3.5

node --experimental-websocket touch-tests.js 2>&1 \
  | grep -v ExperimentalWarning | grep -v 'Use \`node'
