#!/bin/sh
# Drives the unmodified app in headless Chrome and measures the OVERLAY MOTION
# that actually reaches the screen — the shared --ov-* recipe in styles.css that
# the info sheet, live player, donate modal, schedule and on-air chooser all
# open on.
#
# Why this suite exists, and why it measures rather than reads:
# per CLAUDE.md §3a, asserting that a transition is *declared* proves nothing.
# The first version of this probe read the stylesheet back, agreed with itself,
# and would have happily passed a spring that was mathematically perfect and
# visually invisible — which is exactly the bug it then found by sampling the
# computed transform instead: the desktop panels travelled 4% of their height,
# so a 1.4% overshoot came to 0.4px and nobody could ever have seen it. The
# curve was right and the distance was wrong. Only the frame-by-frame numbers
# could tell those apart.
#
# So: it samples getComputedStyle every animation frame and asks questions that
# only real motion can answer — does the panel pass its resting size and come
# back, does the blur pass through intermediate values, is the exit genuinely
# shorter than the entrance, does the phone sheet get time proportionate to the
# full-viewport distance it travels.
set -e
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

curl -sf -m 3 http://localhost:8080/healthz >/dev/null \
  || { echo "the app must be running on :8080 (node server.js)"; exit 1; }

# Per CLAUDE.md §1: name the bundle the browser is about to be handed.
echo "app version: $(curl -s http://localhost:8080/healthz | sed 's/.*"version":"\([^"]*\)".*/\1/')"

# Port 9227: live-stream owns 9222, touch 9223, episode-rail and ui 9224,
# schedule and studio 9225.
#
# The profile is "motion-profile", deliberately WITHOUT the string
# "chrome-profile" in it — test/live-stream's cleanup runs
# `pkill -f "chrome-profile"`, which matches by substring and would otherwise
# kill this browser mid-run.
PORT=9227
PROFILE="$PWD/motion-profile"
cleanup() { pkill -f "motion-profile" 2>/dev/null || true; }
trap cleanup EXIT
cleanup
sleep 1
rm -rf "$PROFILE"

"$CHROME" --headless=new --mute-audio \
  --remote-debugging-port=$PORT \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1400,1000 about:blank > chrome.log 2>&1 &

# Wait for CDP to answer rather than sleeping a fixed interval and hoping.
i=0
while [ $i -lt 40 ]; do
  curl -sf -m 1 "http://127.0.0.1:$PORT/json/list" >/dev/null 2>&1 && break
  i=$((i + 1)); sleep 0.25
done

# Node 20 needs the flag for a WebSocket client; Node 21+ has it natively.
node --experimental-websocket motion-tests.js 2>&1 \
  | grep -v ExperimentalWarning | grep -v 'Use \`node'
