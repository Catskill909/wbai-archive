#!/bin/sh
# Runs the back-to-top suite against the app on :8080.
#
# Like test/touch, this needs no fake station — it asserts scroll behaviour, not
# audio. It DOES need CDP input synthesis: the whole feature is a reaction to real
# scroll gestures, and reading scrollTop or computed styles instead would measure
# the declaration rather than the effect (CLAUDE.md §3a).
set -e
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

curl -sf -m 3 http://localhost:8080/healthz >/dev/null \
  || { echo "the app must be running on :8080 (node server.js)"; exit 1; }

# Per CLAUDE.md §1, a client-side result judged against a stale bundle is worthless.
echo "app version: $(curl -s http://localhost:8080/healthz | sed 's/.*"version":"\([^"]*\)".*/\1/')"

# Port 9224: test/live-stream holds 9222 and test/touch holds 9223, so all three
# suites can run back to back without fighting over a browser. NOTE that
# live-stream's cleanup does `pkill -f "chrome-profile"`, which also matches this
# profile name — that is only a problem if the two run concurrently, which they
# don't.
cleanup() { pkill -f "chrome-profile-totop" 2>/dev/null || true; }
trap cleanup EXIT
cleanup
sleep 1
rm -rf chrome-profile-totop

# 1400x1000 so the run STARTS above the 1360px gutter breakpoint; the suite drops
# to 1000px and 390px itself for the centred-overlay cases.
"$CHROME" --headless=new --mute-audio \
  --remote-debugging-port=9224 \
  --user-data-dir="$PWD/chrome-profile-totop" \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1400,1000 about:blank > chrome.log 2>&1 &
sleep 3.5

node --experimental-websocket to-top-tests.js 2>&1 \
  | grep -v ExperimentalWarning | grep -v 'Use \`node'
