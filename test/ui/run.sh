#!/bin/sh
# Runs the UI-behaviour suites against the app on :8080.
#
#   ./run.sh              all four
#   ./run.sh ui           just one (ui | scroll | clock | rowtap)
#
# Like test/touch, this needs no fake station — it asserts rendered geometry and
# DOM behaviour, not audio. What it covers:
#
#   ui-tests.js      theme switch (incl. the no-flash guarantee), hero clamp,
#                    the phone meta strip, page gutters, and the app bar
#   scroll-tests.js  filtering/sorting sends the list back to its first row
#   clock-tests.js   the freshness label, driven against an intercepted
#                    /api/archive with controlled timestamps
#   row-tap-tests.js every dead zone in a list row opens the info sheet, and
#                    the play column still doesn't
#   cast-tests.js    the Cast/AirPlay button: removed outright where the browser
#                    has no remote playback, weightless where there is no device,
#                    and the player bar still fits with it in

#
# House rule these follow (CLAUDE.md §3a): assert the EFFECT, not the
# declaration. Where a suite asserts an absence ("the page did not move", "the
# tally takes no space"), it also carries a self-test that forces the probe to
# report a failure — an assertion of absence that has never been shown to fail
# is indistinguishable from a blind one.
set -e
cd "$(dirname "$0")"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

curl -sf -m 3 http://localhost:8080/healthz >/dev/null \
  || { echo "the app must be running on :8080 (node server.js)"; exit 1; }

# Per CLAUDE.md §1: name the bundle the browser is about to be handed. A result
# judged against a stale one is worthless.
echo "app version: $(curl -s http://localhost:8080/healthz | sed 's/.*"version":"\([^"]*\)".*/\1/')"

# Port 9224: test/live-stream owns 9222, test/touch owns 9223.
#
# The profile is "ui-profile", deliberately WITHOUT the string "chrome-profile"
# in it — test/live-stream's cleanup runs `pkill -f "chrome-profile"`, which
# matches by substring and would otherwise kill this browser mid-run.
PORT=9224
PROFILE="$PWD/ui-profile"
cleanup() { pkill -f "ui-profile" 2>/dev/null || true; }
trap cleanup EXIT
cleanup
sleep 1
rm -rf "$PROFILE"

"$CHROME" --headless=new --mute-audio \
  --remote-debugging-port=$PORT \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1400,1000 about:blank > chrome.log 2>&1 &

# Wait for CDP to actually answer rather than sleeping a fixed 3.5s and hoping.
# The very first run in a clean checkout has to build the profile from scratch
# and overran that budget once, which surfaced as a handful of failed assertions
# in an otherwise green suite — the worst possible failure mode, because it
# looks like a real regression. Poll instead: ready in ~1s warm, and correct
# when it is not.
i=0
until curl -sf -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -gt 60 ] && { echo "Chrome did not open a debugging port on $PORT"; exit 1; }
  sleep .25
done

case "${1:-all}" in
  ui)     SUITES="ui-tests.js" ;;
  scroll) SUITES="scroll-tests.js" ;;
  clock)  SUITES="clock-tests.js" ;;
  rowtap) SUITES="row-tap-tests.js" ;;
  reload) SUITES="reload-tests.js" ;;
  cast)   SUITES="cast-tests.js" ;;
  all)    SUITES="ui-tests.js scroll-tests.js clock-tests.js row-tap-tests.js reload-tests.js cast-tests.js" ;;
  *)      echo "unknown suite: $1 (use ui | scroll | clock | rowtap | reload | cast)"; exit 2 ;;
esac

# Each suite exits non-zero on failure. Run them all before reporting, so one
# early failure doesn't hide the state of the other two, then fail overall.
#
# Output goes via a temp file rather than a pipe on purpose: in POSIX sh a
# pipeline's status is the LAST command's, so `node ... | grep ... || rc=1`
# would report grep's success and swallow every real failure — a runner that
# always says OK is worse than no runner. The `if` form is also what keeps
# `set -e` from aborting the loop on the first failing suite.
OUT="$PWD/.suite-out"
rc=0
for s in $SUITES; do
  echo
  echo "=== $s ==="
  # Node 20 needs the flag for a WebSocket client; Node 21+ has it natively.
  if CDP_PORT=$PORT node --experimental-websocket "$s" > "$OUT" 2>&1; then :; else rc=1; fi
  grep -v ExperimentalWarning "$OUT" | grep -v 'Use \`node' || true
done
rm -f "$OUT"

echo
[ $rc -eq 0 ] && echo "OK — all UI suites passed" || echo "FAILURES — see above"
exit $rc
