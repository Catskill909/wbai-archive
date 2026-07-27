#!/bin/sh
# Runs the live-stream scenario suite end to end.
#   ./run.sh            Chrome's default autoplay policy (realistic desktop)
#   ./run.sh --strict   user-gesture-required (worst case, stands in for iOS)
# Both should pass. The strict run is the one that catches a drift handover
# regressing into a hard cut — see docs/live-audio-pattern.md §5.
set -e
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }
[ -f tone.mp3 ] || { echo "run ./setup.sh first"; exit 1; }

curl -sf -m 3 http://localhost:8080/healthz >/dev/null \
  || { echo "the app must be running on :8080 (node server.js)"; exit 1; }

STRICT=""
POLICY=""
if [ "$1" = "--strict" ]; then
  STRICT="--strict"
  POLICY="--autoplay-policy=user-gesture-required"
fi

cleanup() {
  # match how the processes were actually launched: chrome by its profile path,
  # node by the script name it was given (relative, because we cd'd here)
  pkill -f "chrome-profile" 2>/dev/null || true
  pkill -f "fakestream.js" 2>/dev/null || true
}
trap cleanup EXIT
cleanup
sleep 1
rm -rf chrome-profile

node fakestream.js > stream.log 2>&1 &
sleep 1.5

# --mute-audio is NOT optional: headless Chrome plays out of the real speakers.
# --host-resolver-rules points the station's hostname at the fake one, so the
# app under test runs completely unmodified — same URL, same CSP.
"$CHROME" --headless=new --mute-audio \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/chrome-profile" \
  --host-resolver-rules="MAP streaming.wbai.org 127.0.0.1:8443" \
  --ignore-certificate-errors --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1400,1000 $POLICY about:blank > chrome.log 2>&1 &
sleep 3.5

# Node 20 needs the flag for a WebSocket client; Node 21+ has it natively.
node --experimental-websocket run-tests.js $STRICT 2>&1 \
  | grep -v ExperimentalWarning | grep -v 'Use \`node'
